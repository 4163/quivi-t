/**
 * urlLoader.js: orchestrator for loading remote galleries via URL.
 *
 * Forefront architectural goal:
 * QuiviT must let maintainers add or replace an individual website extractor
 * without changing or releasing any QuiviT files. A new or updated extractor
 * must reach users through the remote manifest automatically. End users should
 * not need to install an update, copy a file, or change a setting to receive
 * website support.
 *
 * Invariants:
 * - urlLoader.js is strictly provider-agnostic. Domain names, site-specific
 *   selectors, and vendor regexes belong exclusively inside extractor modules.
 * - Ownership split: extractors declare site facts (placement, absorbed
 *   standalones, jump targets). Core decides matching, clearing, queueing,
 *   and opening through one shared vocabulary, and never interprets what a
 *   layer means. The extractors README is the contract.
 * - Fetches remote manifest, matches user URLs to extractors, and dynamically
 *   imports extractor modules via Blob URL + dynamic import().
 * - Coordinates page fetching, pagination, gallery sidecars, and direct media.
 *
 * Download lifecycle:
 * - Downloads are viewport-aware: only visible images plus a buffer are
 *   scheduled. Navigation cancels in-flight work and restarts from the
 *   new position. Directory exit cancels everything.
 * - The viewer holds the previous image until the target download
 *   completes, so the screen is never blank during a jump.
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
  'apng', 'avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'mp4', 'png', 'svg', 'webp'
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
const _resolvingGalleries = new Set();
const _resumingGalleries = new Map();

// Blob URLs tracked separately for revocation on cache eviction.
// Each cache key maps to an array of blob URLs (entry + all dep blobs).
const _blobUrls = new Map();
const _extractorCache = new BoundedMap(EXTRACTOR_MODULE_CACHE_CAPACITY, (id) => {
  const urls = _blobUrls.get(id);
  if (urls) {
    for (const url of Array.isArray(urls) ? urls : [urls]) {
      try { URL.revokeObjectURL(url); } catch (_) {}
    }
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
  if (image.fallbackUrl && !isValidUrl(image.fallbackUrl)) {
    throw new Error(`Extractor returned an invalid image fallback URL at index ${index}`);
  }
  if (image.headers !== undefined && image.headers !== null) {
    if (typeof image.headers !== 'object' || Array.isArray(image.headers)) {
      throw new Error(`Extractor returned invalid image headers at index ${index}`);
    }
    for (const [k, v] of Object.entries(image.headers)) {
      if (typeof k !== 'string' || typeof v !== 'string') {
        throw new Error(`Extractor returned non-string header entry at index ${index}`);
      }
    }
  }
  if (image.decryption !== undefined && image.decryption !== null) {
    if (typeof image.decryption !== 'object' || image.decryption.algorithm !== 'xor' || typeof image.decryption.key !== 'string') {
      throw new Error(`Extractor returned invalid decryption descriptor at index ${index} (only algorithm: 'xor' is supported)`);
    }
  }
  if (image.descramble !== undefined && image.descramble !== null) {
    if (typeof image.descramble !== 'object'
      || image.descramble.algorithm !== 'tile-grid'
      || typeof image.descramble.cols !== 'number'
      || typeof image.descramble.rows !== 'number'
      || !Array.isArray(image.descramble.order)
      || image.descramble.order.length !== image.descramble.cols * image.descramble.rows
      || (image.descramble.align !== undefined && typeof image.descramble.align !== 'number')) {
      throw new Error(`Extractor returned invalid descramble descriptor at index ${index}`);
    }
  }
  if (image.supersedes !== undefined && image.supersedes !== null) {
    if (!Array.isArray(image.supersedes)) {
      throw new Error(`Extractor returned invalid supersedes at index ${index}: must be an array`);
    }
    for (let i = 0; i < image.supersedes.length; i++) {
      if (typeof image.supersedes[i] !== 'string' || !image.supersedes[i].trim()) {
        throw new Error(`Extractor returned invalid supersedes entry at index ${index}[${i}]`);
      }
    }
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

  if (/^blob:/i.test(trimmed)) {
    return trimmed;
  }
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
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'blob:';
  } catch {
    return false;
  }
}

// -- Network & Shell proxies --

export async function fetchRemoteText(url, headers) {
  if (!window.__TAURI__) {
    throw new Error('Backend network proxy unavailable in browser environment');
  }
  return await window.__TAURI__.core.invoke('fetch_text', { url, headers: headers || undefined });
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
  if (options.headers) args.headers = options.headers;
  if (options.xorKey) args.xorKey = options.xorKey;
  if (options.descramble) args.descramble = options.descramble;
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

export async function reloadLibraryDir() {
  _libraryDirCache = null;
  return getLibraryDir();
}

export function getCachedLibraryDir() {
  return _libraryDirCache;
}

// -- Path comparison helper --

function _pathsEqual(a, b) {
  if (!a || !b) return false;
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

function _isPathWithin(path, root) {
  if (!path || !root) return false;
  const cleanPath = String(path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const cleanRoot = String(root).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return cleanPath === cleanRoot || cleanPath.startsWith(`${cleanRoot}/`);
}

function _rebasePath(path, oldRoot, newRoot) {
  if (!_isPathWithin(path, oldRoot)) return path;
  const cleanPath = String(path).replace(/\\/g, '/');
  const cleanRoot = String(oldRoot).replace(/\\/g, '/').replace(/\/+$/, '');
  const suffix = cleanPath.slice(cleanRoot.length);
  return `${String(newRoot).replace(/[\\/]+$/, '')}${suffix.replace(/\//g, '\\')}`;
}

// -- Staggered Download Queue --

export class DownloadQueue {
  constructor(items = [], options = {}) {
    this._items = items.map((item, i) => {
      const destPath = item.destPath || '';
      const filename = item.filename || (destPath ? destPath.replace(/\\/g, '/').split('/').pop() : '');
      return {
        url: item.url,
        fallbackUrl: item.fallbackUrl || null,
        destPath,
        filename,
        galleryIndex: item.galleryIndex ?? i,
        status: item.status || 'pending',
        retryCount: 0,
        headers: item.headers || null,
        decryption: item.decryption || null,
        descramble: item.descramble || null
      };
    });
    this._onItemStatusChanged = options.onItemStatusChanged || null;
    this._downloadFile = options.downloadFile || downloadFile;
    this._cancelDownload = options.cancelDownload || cancelDownload;
    this._prefetchStartThresholdPercent = options.prefetchStartThresholdPercent ?? PREFETCH_START_THRESHOLD_PERCENT;
    this._retryDelayMs = options.retryDelayMs ?? 0;
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
      if (item.filename && cleanTarget.endsWith('/' + item.filename.toLowerCase())) return true;
      if (cleanItem.endsWith('/' + targetName)) return true;
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
    if (this._visibleEnd > this._visibleStart && item.galleryIndex >= this._visibleStart && item.galleryIndex < this._visibleEnd) {
      return true;
    }
    const activeItem = this._findItem(this._activeDestPath);
    if (activeItem && Math.abs(item.galleryIndex - activeItem.galleryIndex) <= 1) {
      return true;
    }
    return false;
  }

  _getNextPrefetchItem() {
    const pending = this._items.filter((item) => item.status === 'pending' && !this._inFlightItems.has(item));
    if (pending.length === 0) return null;

    let pivotGi = Math.max(0, this._visibleStart);
    const activeItem = this._findItem(this._activeDestPath);
    if (activeItem) pivotGi = activeItem.galleryIndex;

    const visiblePending = pending.filter((item) => this._isInViewport(item));
    const hasVisibleRange = this._visibleEnd > this._visibleStart;
    const candidates = hasVisibleRange ? visiblePending : pending;
    if (candidates.length === 0) return null;

    const forward = candidates
      .filter((item) => item.galleryIndex >= pivotGi)
      .sort((a, b) => a.galleryIndex - b.galleryIndex);
    if (forward.length > 0) return forward[0];

    const backward = candidates
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
    let currentUrl = item.url;
    let fallbackTried = false;

    while (!success && item.retryCount <= DOWNLOAD_QUEUE_RETRY_LIMIT && this._isCurrentAttempt(attempt)) {
      try {
        await this._downloadFile(currentUrl, item.destPath, {
          requestId: attempt.requestId,
          queueGeneration: attempt.generation,
          thresholdPercent: attempt.kind === 'prefetch' ? this._prefetchStartThresholdPercent : null,
          headers: item.headers || undefined,
          xorKey: item.decryption?.key || undefined,
          descramble: item.descramble || undefined
        });
        success = true;
      } catch (err) {
        const msg = String(err?.message || err || '');
        if (msg.includes('cancelled') || msg.includes('canceled')) {
          item.retryCount = 0;
          break;
        }

        const fallback = item.fallbackUrl || null;

        if (!fallbackTried && fallback && fallback !== currentUrl) {
          currentUrl = fallback;
          fallbackTried = true;
          continue;
        }

        item.retryCount++;
        if (item.retryCount <= DOWNLOAD_QUEUE_RETRY_LIMIT) {
          if (this._retryDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, this._retryDelayMs));
          }
        } else {
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

    if (attempt.kind === 'active') {
      this._prefetchUnlocked = true;
    }
    this._admitPendingPrefetch();
    this._refreshWhenComplete();
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

export async function fetchManifest({ refresh = false } = {}) {
  if (_manifestCache && !refresh) return _manifestCache;

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

const _EXTRACTOR_HEADER_RE = /^\/\/\s*quivit-(deps|needs):\s*(.+)$/;
const _IMPORT_SPECIFIER_RE = /(?<=from\s+['"])([^'"]+)(?=['"])/g;

export function _parseExtractorHeaders(sourceText) {
  const deps = [];
  const needs = [];
  for (const line of sourceText.split('\n').slice(0, 5)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = _EXTRACTOR_HEADER_RE.exec(trimmed);
    if (!m) break;
    const values = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    if (m[1] === 'deps') deps.push(...values);
    else needs.push(...values);
  }
  return { deps, needs };
}

async function _resolveDepGraph(entrySource, entryPath) {
  const graph = new Map();
  const visiting = new Set();

  async function walk(source, filePath) {
    const { deps } = _parseExtractorHeaders(source);
    for (const depPath of deps) {
      if (graph.has(depPath)) continue;
      if (!SAFE_EXTRACTOR_SOURCE_RE.test(depPath) || depPath.includes('..')) {
        throw new Error(`Extractor declares an invalid dependency path: ${depPath}`);
      }
      if (visiting.has(depPath)) {
        throw new Error(`Extractor dependency cycle detected: ${depPath}`);
      }
      visiting.add(depPath);
      const depSource = await fetchExtractorText(depPath);
      await walk(depSource, depPath);
      const rewrittenDep = _rewriteImportSpecifiers(depSource, depPath, graph);
      const depBlob = new Blob([rewrittenDep], { type: 'text/javascript' });
      const depBlobUrl = URL.createObjectURL(depBlob);
      graph.set(depPath, { source: depSource, blobUrl: depBlobUrl });
      visiting.delete(depPath);
    }
  }

  await walk(entrySource, entryPath);
  return graph;
}

function _resolveImportPath(importerPath, specifier) {
  if (!specifier.startsWith('.')) {
    throw new Error(`Extractor imports must use relative paths: ${specifier}`);
  }
  const base = importerPath.split('/').slice(0, -1);
  for (const seg of specifier.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') {
      if (base.length === 0) throw new Error(`Extractor import escapes the branch root: ${specifier}`);
      base.pop();
    } else {
      base.push(seg);
    }
  }
  const resolved = base.join('/');
  if (!SAFE_EXTRACTOR_SOURCE_RE.test(resolved) || resolved.includes('..')) {
    throw new Error(`Extractor imports an invalid path: ${specifier}`);
  }
  return resolved;
}

function _rewriteImportSpecifiers(source, importerPath, depGraph) {
  return source.replace(_IMPORT_SPECIFIER_RE, (specifier) => {
    // Resolve './proto.js' against the importing file's own directory,
    // so transitive deps rewrite correctly ('shared/mangaplus.js' + './proto.js').
    const resolved = _resolveImportPath(importerPath, specifier);
    const dep = depGraph.get(resolved);
    if (!dep) throw new Error(`Extractor imports '${specifier}' which is not declared in quivit-deps`);
    return dep.blobUrl;
  });
}

async function _hashTexts(texts) {
  if (texts.length === 0) return '';
  const combined = texts.join('\n');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(combined));
  return ':' + Array.from(new Uint8Array(buf)).slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}
const SUPPORTED_EXTRACTOR_CAPABILITIES = new Set(['fetchBytes', 'requestHeaders', 'xorDecrypt', 'tileDescramble']);

async function _fetchBytes(url, headers) {
  if (!window.__TAURI__) {
    throw new Error('Backend network proxy unavailable in browser environment');
  }
  const b64 = await window.__TAURI__.core.invoke('fetch_bytes', { url, headers: headers || undefined });
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function loadExtractorModule(entry) {
  const source = await fetchExtractorText(entry.source);
  const { needs } = _parseExtractorHeaders(source);
  if (needs.length > 0) {
    const missing = needs.filter((cap) => !SUPPORTED_EXTRACTOR_CAPABILITIES.has(cap));
    if (missing.length > 0) {
      throw new Error(`This extractor requires a newer version of QuiviT (missing: ${missing.join(', ')})`);
    }
  }
  const depGraph = await _resolveDepGraph(source, entry.source);
  const contentHash = await _hashTexts([source, ...Array.from(depGraph.values()).map((d) => d.source)]);
  const cacheKey = `${entry.id}@${entry.version}:${entry.source}${contentHash}`;

  const cached = _extractorCache.get(cacheKey);
  if (cached) return cached;

  const rewritten = _rewriteImportSpecifiers(source, entry.source, depGraph);
  const blob = new Blob([rewritten], { type: 'text/javascript' });
  const entryBlobUrl = URL.createObjectURL(blob);

  let mod;
  try {
    mod = await import(entryBlobUrl);
  } catch (e) {
    URL.revokeObjectURL(entryBlobUrl);
    for (const dep of depGraph.values()) URL.revokeObjectURL(dep.blobUrl);
    throw new Error(`Failed to load extractor '${entry.id}': ${e.message}`);
  }

  if (typeof mod.match !== 'function' || typeof mod.extract !== 'function') {
    URL.revokeObjectURL(entryBlobUrl);
    for (const dep of depGraph.values()) URL.revokeObjectURL(dep.blobUrl);
    throw new Error(`Extractor '${entry.id}' missing required match() or extract() export`);
  }

  const allBlobUrls = Array.from(depGraph.values()).map((d) => d.blobUrl);
  allBlobUrls.push(entryBlobUrl);
  _blobUrls.set(cacheKey, allBlobUrls);
  _extractorCache.set(cacheKey, mod);
  return mod;
}

export function getExtractorCacheKey(entry) {
  return `${entry.id}@${entry.version}:${entry.source}`;
}

// -- Gallery extraction --

export function validateExtractorResult(result, entry) {
  if (!result || typeof result.provider !== 'string') {
    throw new Error("Extractor returned invalid result: missing 'provider' field");
  }
  if (entry && result.provider !== entry.name) {
    throw new Error(`Extractor provider '${result.provider}' does not match manifest entry '${entry.name}'`);
  }

  if (result.metadata !== undefined && result.metadata !== null) {
    if (typeof result.metadata !== 'string' && typeof result.metadata !== 'object') {
      throw new Error("Extractor returned invalid result: 'metadata' must be an object or string");
    }
    if (typeof result.metadata === 'object' && typeof result.metadata.filename === 'string') {
      _validateWindowsName(result.metadata.filename, 'metadata filename');
    }
  }

  if (result.folders !== undefined && result.folders !== null) {
    if (!Array.isArray(result.folders)) {
      throw new Error("Extractor returned invalid result: 'folders' must be an array");
    }
    for (let i = 0; i < result.folders.length; i++) {
      const folder = result.folders[i];
      if (!folder || typeof folder !== 'object') {
        throw new Error(`Extractor returned invalid folder at index ${i}`);
      }
      if (!Array.isArray(folder.relativePath) || folder.relativePath.length === 0
        || folder.relativePath.length > MAX_GALLERY_PATH_DEPTH) {
        throw new Error(`Extractor returned invalid folder relativePath at index ${i}`);
      }
      for (const segment of folder.relativePath) {
        _validateWindowsName(segment, `folder relativePath segment at index ${i}`);
      }
      if (folder.metadata !== undefined && folder.metadata !== null) {
        if (typeof folder.metadata !== 'string' && typeof folder.metadata !== 'object') {
          throw new Error(`Extractor returned invalid metadata on folder at index ${i}`);
        }
        if (typeof folder.metadata === 'object' && typeof folder.metadata.filename === 'string') {
          _validateWindowsName(folder.metadata.filename, `folder metadata filename at index ${i}`);
        }
      }
    }
  }

  if (result.isSeries === true) {
    if (!Array.isArray(result.rootRelativePath) || result.rootRelativePath.length === 0
      || result.rootRelativePath.length > MAX_GALLERY_PATH_DEPTH) {
      throw new Error("Extractor returned invalid series result: rootRelativePath must be a non-empty path");
    }
    for (const segment of result.rootRelativePath) {
      _validateWindowsName(segment, 'series root relativePath segment');
    }
    if (result.cover) {
      _validateImage(result.cover, 'cover');
    }
    if (!Array.isArray(result.chapters)) {
      throw new Error("Extractor returned invalid series result: 'chapters' must be an array");
    }
    for (let i = 0; i < result.chapters.length; i++) {
      const chapter = result.chapters[i];
      if (!chapter || typeof chapter !== 'object') {
        throw new Error(`Extractor returned invalid chapter at index ${i}`);
      }
      if (typeof chapter.id !== 'string' || !chapter.id.trim()) {
        throw new Error(`Extractor returned missing chapter id at index ${i}`);
      }
      if (!isValidUrl(chapter.sourceUrl)) {
        throw new Error(`Extractor returned invalid chapter sourceUrl at index ${i}`);
      }
      if (!Array.isArray(chapter.relativePath) || chapter.relativePath.length === 0
        || chapter.relativePath.length > MAX_GALLERY_PATH_DEPTH) {
        throw new Error(`Extractor returned invalid chapter relativePath at index ${i}`);
      }
      for (const segment of chapter.relativePath) {
        _validateWindowsName(segment, `chapter relativePath segment at index ${i}`);
      }
      if (chapter.metadata !== undefined && chapter.metadata !== null) {
        if (typeof chapter.metadata !== 'string' && typeof chapter.metadata !== 'object') {
          throw new Error(`Extractor returned invalid metadata on chapter at index ${i}`);
        }
        if (typeof chapter.metadata === 'object' && typeof chapter.metadata.filename === 'string') {
          _validateWindowsName(chapter.metadata.filename, `chapter metadata filename at index ${i}`);
        }
      }
      if (chapter.cover) {
        _validateImage(chapter.cover, `chapter ${i} cover`);
      }
    }
    return result;
  }

  _validateGallery(result.gallery);
  if (!Array.isArray(result.images)) {
    throw new Error("Extractor returned invalid result: 'images' must be an array");
  }
  result.images.forEach(_validateImage);
  _validateGalleryImageNames(result.images);
  if (result.targetFilename !== undefined && result.targetFilename !== null) {
    if (typeof result.targetFilename !== 'string' || !result.targetFilename.trim()) {
      throw new Error("Extractor returned invalid result: 'targetFilename' must be a non-empty string");
    }
  }
  return result;
}

export function extractGallery(extractor, html, url, context = {}, entry = null) {
  const done = (res) => {
    if (res && typeof res.error === 'string' && typeof res.provider !== 'string') {
      throw new Error(res.error);
    }
    return validateExtractorResult(res, entry);
  };
  const result = extractor.extract(html, url, context);
  if (result && typeof result.then === 'function') {
    return result.then(done);
  }
  return done(result);
}

// -- Gallery Matching & Standalone Raw Cleanup --

export function extractUrlStem(urlOrFilename) {
  if (!urlOrFilename || typeof urlOrFilename !== 'string') return '';
  try {
    const rawPath = urlOrFilename.includes('://')
      ? new URL(urlOrFilename).pathname
      : urlOrFilename;
    const cleanPath = rawPath.split(/[?#]/)[0];
    const segment = cleanPath.split(/[\\/]/).pop() || '';
    const dotIdx = segment.lastIndexOf('.');
    return (dotIdx > 0 ? segment.slice(0, dotIdx) : segment).toLowerCase();
  } catch {
    const clean = urlOrFilename.split(/[?#]/)[0];
    const segment = clean.split(/[\\/]/).pop() || '';
    const dotIdx = segment.lastIndexOf('.');
    return (dotIdx > 0 ? segment.slice(0, dotIdx) : segment).toLowerCase();
  }
}

export function isDirectMediaUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const rawPath = url.includes('://') ? new URL(url).pathname : url;
    const cleanPath = rawPath.split(/[?#]/)[0];
    const segment = cleanPath.split(/[\\/]/).pop() || '';
    const dotIdx = segment.lastIndexOf('.');
    if (dotIdx > 0) {
      const ext = segment.slice(dotIdx + 1).toLowerCase();
      return SUPPORTED_IMAGE_EXTENSIONS.has(ext);
    }
  } catch {}
  return false;
}

// Contract jump tiers, highest wins. Exact address beats fuzzy match
// inside every tier: gallery content outranks a loose root file, which
// outranks a series cover. The top tier returns immediately as a scan
// fast path, which is behavior-neutral since nothing outranks it.
const RANK_GALLERY_CONTENT = 30;
const RANK_ROOT_LOOSE = 20;
const RANK_SERIES_COVER = 10;

function _rankGalleryMatch(img, exact, isProviderRoot) {
  const isSeriesCover = img.description === 'Series Cover' || img.isSeriesCover === true;
  const tier = isSeriesCover ? RANK_SERIES_COVER : (isProviderRoot ? RANK_ROOT_LOOSE : RANK_GALLERY_CONTENT);
  return tier + (exact ? 1 : 0);
}

export async function findMatchingGalleryImage(providerPath, directUrl, hash) {
  if (typeof window === 'undefined' || !window.__TAURI__) return null;
  try {
    const normalizedDirectUrl = normalizeUrl(directUrl);
    const targetStem = (hash ? hash.toLowerCase() : '') || extractUrlStem(directUrl);
    const matchKeys = { urls: new Set([normalizedDirectUrl]), stems: new Set(targetStem ? [targetStem] : []) };
    const directories = [{ path: providerPath, depth: 0 }];
    let bestMatch = null;
    let bestScore = -1;

    while (directories.length > 0) {
      const current = directories.shift();
      const sidecarPath = `${current.path}\\gallery.json`;
      let sidecar = null;
      try {
        const sidecarText = await window.__TAURI__.core.invoke('read_text_file', { path: sidecarPath });
        sidecar = JSON.parse(sidecarText);
        if (Array.isArray(sidecar.images)) {
          for (const img of sidecar.images) {
            const verdict = matchSidecarRecord(img, matchKeys);
            const exact = verdict === 'exact';
            const fuzzy = verdict === 'fuzzy';

            if (!exact && !fuzzy) continue;
            const score = _rankGalleryMatch(img, exact, current.depth === 0);
            const matchResult = {
              galleryPath: current.path,
              targetName: img.filename,
              image: img
            };
            if (score > RANK_GALLERY_CONTENT) {
              return matchResult;
            }
            if (score > bestScore) {
              bestScore = score;
              bestMatch = matchResult;
            }
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
      const subdirs = (dirResult?.files || []).filter((entry) => entry.is_dir);
      // Visit order only: plain path order keeps same-tier ties deterministic.
      subdirs.sort((a, b) => String(a.path || '').localeCompare(String(b.path || '')));
      for (const entry of subdirs) {
        directories.push({ path: entry.path, depth: current.depth + 1 });
      }
    }
    return bestMatch;
  } catch {
    // Provider directory may not exist yet or failed to read.
  }
  return null;
}

export async function findMatchingGalleryBySourceUrl(providerPath, sourceUrl, galleryId) {
  if (typeof window === 'undefined' || !window.__TAURI__) return null;
  try {
    const normalizedTarget = normalizeUrl(sourceUrl || '');
    const targetId = galleryId ? galleryId.toLowerCase() : null;
    const directories = [{ path: providerPath, depth: 0 }];

    while (directories.length > 0) {
      const current = directories.shift();
      const sidecarPath = `${current.path}\\gallery.json`;
      try {
        const sidecarText = await window.__TAURI__.core.invoke('read_text_file', { path: sidecarPath });
        const sidecar = JSON.parse(sidecarText);
        const sidecarId = sidecar?.gallery?.id ? sidecar.gallery.id.toLowerCase() : null;
        const sidecarUrl = normalizeUrl(sidecar?.url || sidecar?.sourceUrl || '');

        let isMatch = false;
        if (targetId && sidecarId && sidecarId === targetId) {
          isMatch = true;
        } else if (normalizedTarget && sidecarUrl && sidecarUrl === normalizedTarget) {
          isMatch = true;
        }

        if (isMatch) {
          return {
            galleryPath: current.path,
            sidecar
          };
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

// One match vocabulary for all provider-root cleanup: normalized URLs,
// stems, and filenames drawn from image-likes plus their supersedes lists.
export function buildMatchSets(images) {
  const urls = new Set();
  const stems = new Set();
  const filenames = new Set();

  const addSuperseded = (entry) => {
    if (typeof entry !== 'string' || !entry.trim()) return;
    const trimmed = entry.trim();
    urls.add(normalizeUrl(trimmed).toLowerCase());
    const stem = extractUrlStem(trimmed);
    if (stem) stems.add(stem);
  };

  for (const img of images || []) {
    if (!img) continue;
    if (typeof img.filename === 'string' && img.filename) filenames.add(img.filename.toLowerCase());
    if (typeof img.rawFileName === 'string' && img.rawFileName) filenames.add(img.rawFileName.toLowerCase());
    if (typeof img.hash === 'string' && img.hash) stems.add(img.hash.toLowerCase());
    if (typeof img.stem === 'string' && img.stem) stems.add(img.stem.toLowerCase());
    for (const key of ['sourceUrl', 'url']) {
      const value = img[key];
      if (typeof value !== 'string' || !value) continue;
      urls.add(normalizeUrl(value).toLowerCase());
      const stem = extractUrlStem(value);
      if (stem) stems.add(stem);
    }
    if (Array.isArray(img.supersedes)) {
      for (const entry of img.supersedes) addSuperseded(entry);
    }
  }

  return { urls, stems, filenames };
}

// Cover identifiers that plain image-likes cannot express: extra filenames
// per cover, volume-derived names, and policy extras.
export function addCoverIdentifiers(sets, coverList, seriesTitle, policy = {}) {
  for (const c of coverList || []) {
    if (!c) continue;
    if (Array.isArray(c.filenames)) {
      for (const fn of c.filenames) {
        if (typeof fn !== 'string' || !fn) continue;
        sets.filenames.add(fn.toLowerCase());
        const stem = fn.replace(/\.[^.]+$/, '').toLowerCase();
        if (stem) sets.stems.add(stem);
      }
    }
    if (seriesTitle && c.volume) {
      sets.stems.add(`${seriesTitle} - Vol. ${c.volume} Cover`.toLowerCase());
    }
  }
  if (Array.isArray(policy.matchStems)) {
    for (const s of policy.matchStems) {
      if (s) sets.stems.add(String(s).toLowerCase());
    }
  }
  if (Array.isArray(policy.matchFilenames)) {
    for (const f of policy.matchFilenames) {
      if (!f) continue;
      sets.filenames.add(String(f).toLowerCase());
      const stem = String(f).replace(/\.[^.]+$/, '').toLowerCase();
      if (stem) sets.stems.add(stem);
    }
  }
  return sets;
}

// One record matcher for jump selection and cleanup linking. Exact means
// a normalized address hit, fuzzy means a shared stem. Returns 'exact',
// 'fuzzy', or 'none'.
export function matchSidecarRecord(record, keys) {
  if (!record) return 'none';
  const recordUrls = [record.sourceUrl, record.url]
    .filter((value) => typeof value === 'string' && value)
    .map((value) => normalizeUrl(value).toLowerCase());
  if (recordUrls.some((value) => keys.urls.has(value))) return 'exact';
  const recordStems = new Set();
  for (const value of [record.sourceUrl, record.url]) {
    if (typeof value !== 'string' || !value) continue;
    const stem = extractUrlStem(value);
    if (stem) recordStems.add(stem);
  }
  for (const value of [record.hash, record.rawFileName]) {
    if (typeof value !== 'string' || !value) continue;
    recordStems.add(value.toLowerCase());
    const stem = extractUrlStem(value);
    if (stem) recordStems.add(stem);
  }
  if ([...recordStems].some((stem) => keys.stems.has(stem))) return 'fuzzy';
  return 'none';
}

// A standalone whose recorded address matches is the same file even when
// the gallery renamed it, and host variants of one address share a stem
// even when the full URLs differ.
async function linkRootSidecarRecords(providerPath, sets) {
  try {
    const sidecarText = await window.__TAURI__.core.invoke('read_text_file', {
      path: `${providerPath}\\gallery.json`
    });
    const sidecar = JSON.parse(sidecarText);
      if (sidecar && Array.isArray(sidecar.images)) {
        for (const record of sidecar.images) {
          if (matchSidecarRecord(record, sets) === 'none') continue;
          if (record.filename) sets.filenames.add(record.filename.toLowerCase());
          if (record.rawFileName) sets.filenames.add(record.rawFileName.toLowerCase());
        }
      }
  } catch {
    // No root sidecar or unreadable; stem and filename matching still applies.
  }
}

// Prune the records of deleted files so later jumps stop finding ghosts.
async function pruneRootSidecarRecords(providerPath, deletedNames) {
  if (deletedNames.size === 0) return;
  try {
    const sidecarPath = `${providerPath}\\gallery.json`;
    const sidecarText = await window.__TAURI__.core.invoke('read_text_file', { path: sidecarPath });
    const sidecar = JSON.parse(sidecarText);
    if (!sidecar || !Array.isArray(sidecar.images)) return;
    const remaining = sidecar.images.filter((record) => !deletedNames.has((record?.filename || '').toLowerCase()));
    if (remaining.length === sidecar.images.length) return;
    if (remaining.length > 0) {
      sidecar.images = remaining;
      await window.__TAURI__.core.invoke('write_text_file', {
        path: sidecarPath,
        content: JSON.stringify(sidecar, null, 2)
      });
    } else {
      await window.__TAURI__.core.invoke('remove_file', { path: sidecarPath });
    }
  } catch {
    // Non-fatal sidecar prune failure; files are already deleted.
  }
}

async function cleanupRootFiles(providerPath, dirFiles, sets) {
  await linkRootSidecarRecords(providerPath, sets);
  const deletedNames = new Set();
  for (const entry of dirFiles || []) {
    if (entry.is_dir) continue;
    const lowerName = (entry.name || '').toLowerCase();
    if (lowerName === 'gallery.json') continue;
    const dotIndex = lowerName.lastIndexOf('.');
    const fileBase = (dotIndex > 0 ? lowerName.slice(0, dotIndex) : lowerName).toLowerCase();
    if (sets.stems.has(fileBase) || sets.filenames.has(lowerName)) {
      try {
        await window.__TAURI__.core.invoke('remove_file', { path: entry.path });
        deletedNames.add(lowerName);
      } catch (err) {
        console.warn('[UrlLoader] Failed to remove matching root file:', entry.path, err);
      }
    }
  }
  await pruneRootSidecarRecords(providerPath, deletedNames);
}

export async function cleanupMatchingRawFiles(providerPath, images) {
  if (typeof window === 'undefined' || !window.__TAURI__ || !Array.isArray(images) || images.length === 0) return;
  try {
    const dirResult = await window.__TAURI__.core.invoke('read_directory', {
      path: providerPath,
      showHidden: false
    });
    if (!dirResult?.files) return;
    await cleanupRootFiles(providerPath, dirResult.files, buildMatchSets(images));
  } catch {
    // Provider directory does not exist or read failed.
  }
}

export async function recordRootMediaDownload(providerPath, providerName, item) {
  if (typeof window === 'undefined' || !window.__TAURI__ || !item?.filename) return;
  const sidecarPath = `${providerPath}\\gallery.json`;
  let sidecar = null;
  try {
    const text = await window.__TAURI__.core.invoke('read_text_file', { path: sidecarPath });
    sidecar = JSON.parse(text);
  } catch {
    // Root sidecar does not exist yet
  }

  if (!sidecar || typeof sidecar !== 'object') {
    sidecar = {
      provider: providerName || 'Library',
      isRoot: true,
      title: `${providerName || 'Library'} Downloads`,
      timestamp: new Date().toISOString(),
      images: []
    };
  }
  if (!Array.isArray(sidecar.images)) {
    sidecar.images = [];
  }

  const itemSets = buildMatchSets([{
    sourceUrl: item.sourceUrl,
    url: item.url,
    hash: item.hash,
    filename: item.filename,
    rawFileName: item.rawFileName
  }]);

  sidecar.images = sidecar.images.filter((img) => {
    if (!img) return true;
    if (matchSidecarRecord(img, itemSets) !== 'none') return false;
    const name = typeof img.filename === 'string' ? img.filename.toLowerCase() : '';
    const raw = typeof img.rawFileName === 'string' ? img.rawFileName.toLowerCase() : '';
    return !itemSets.filenames.has(name) && !itemSets.filenames.has(raw);
  });

  sidecar.images.push({
    filename: item.filename,
    rawFileName: item.rawFileName || item.filename,
    hash: item.hash || extractUrlStem(item.url || item.sourceUrl || ''),
    sourceUrl: item.sourceUrl || item.url || '',
    url: item.url || item.sourceUrl || '',
    timestamp: item.timestamp || new Date().toISOString()
  });

  try {
    await window.__TAURI__.core.invoke('write_text_file', {
      path: sidecarPath,
      content: JSON.stringify(sidecar, null, 2)
    });
  } catch (err) {
    console.warn('[UrlLoader] Failed to write root gallery.json:', err);
  }
}

export async function writeGalleryMetadata(targetDir, metadata) {
  if (!targetDir || !metadata || typeof window === 'undefined' || !window.__TAURI__) return;

  let filename = 'comicinfo.json';
  let content = '';

  if (typeof metadata === 'string') {
    content = metadata;
    if (metadata.trim().startsWith('<')) {
      filename = 'comicinfo.xml';
    }
  } else if (typeof metadata === 'object') {
    if (typeof metadata.filename === 'string' && metadata.content !== undefined) {
      filename = _validateWindowsName(metadata.filename, 'metadata filename');
      content = typeof metadata.content === 'string'
        ? metadata.content
        : JSON.stringify(metadata.content, null, 2);
    } else {
      filename = 'comicinfo.json';
      content = JSON.stringify(metadata, null, 2);
    }
  }

  if (!content) return;

  try {
    await window.__TAURI__.core.invoke('write_text_file', {
      path: `${targetDir}\\${filename}`,
      content
    });
  } catch (err) {
    console.warn('[UrlLoader] Failed to write gallery metadata:', err);
  }
}

// Chapter stub cover record. Appended last so it never becomes the open
// target, and marked Series Cover so matching ranks it below content.
export function buildStubCoverRecord(cover) {
  if (!cover || typeof cover.url !== 'string' || !cover.url
    || typeof cover.filename !== 'string' || !cover.filename) return null;
  return {
    filename: cover.filename,
    displayName: cover.filename,
    description: 'Series Cover',
    sourceUrl: cover.url
  };
}

// The Library tree lists only direct provider children carrying gallery.json.
// For gallery paths deeper than one tier, the intermediate folders would stay
// invisible, so each gets a minimal marker sidecar. Markers carry no url,
// sourceUrl, or unresolved flag, keeping them invisible to gallery matching,
// cleanup, and stub resolution. Real sidecars always win: existing files are
// never overwritten, and later leaf writes replace markers outright.
async function _ensureIntermediateSidecars(galleryPath, galleryId, relativePath, { provider, entry } = {}) {
  if (!window.__TAURI__ || !galleryPath || !Array.isArray(relativePath) || relativePath.length < 2) return;
  const segs = String(galleryPath).split('\\');
  const rootSegs = segs.slice(0, Math.max(0, segs.length - relativePath.length));
  for (let depth = 1; depth < relativePath.length; depth++) {
    const tier = relativePath.slice(0, depth);
    const tierPath = [...rootSegs, ...tier].join('\\');
    const sidecarPath = `${tierPath}\\gallery.json`;
    try {
      await window.__TAURI__.core.invoke('read_text_file', { path: sidecarPath });
      continue;
    } catch {
      // Absent; write a marker below.
    }
    const marker = {
      provider,
      title: tier[tier.length - 1],
      timestamp: new Date().toISOString(),
      gallery: {
        id: `${galleryId}-tier-${depth}`,
        relativePath: tier,
        extractorId: entry?.id,
        extractorVersion: entry?.version
      },
      images: []
    };
    try {
      await window.__TAURI__.core.invoke('write_text_file', {
        path: sidecarPath,
        content: JSON.stringify(marker, null, 2)
      });
    } catch (err) {
      console.warn('[UrlLoader] Failed to write intermediate gallery sidecar:', err);
    }
  }
}

export async function cleanupMatchingProviderEntries(providerPath, result) {
  if (typeof window === 'undefined' || !window.__TAURI__ || !result || typeof result !== 'object') {
    return;
  }

  if (result.cleanup === false) {
    return;
  }

  try {
    const dirResult = await window.__TAURI__.core.invoke('read_directory', {
      path: providerPath,
      showHidden: false
    });
    if (!dirResult?.files) return;

    const cleanupPolicy = result.cleanup || {};
    const shouldRemoveChapters = result.isSeries === true && cleanupPolicy.removeMatchingChapters !== false;
    const shouldRemoveCovers = cleanupPolicy.removeLooseCovers === true;
    const shouldRemoveLooseFiles = !result.isSeries && cleanupPolicy.removeLooseFiles !== false && Array.isArray(result.images);

    const seriesRootName = (result.rootRelativePath?.[0] || result.title || '').toLowerCase();
    const chapterIds = new Set();
    const chapterUrls = new Set();

    if (shouldRemoveChapters && Array.isArray(result.chapters)) {
      for (const ch of result.chapters) {
        if (ch?.id) chapterIds.add(ch.id.toLowerCase());
        const norm = normalizeUrl(ch?.sourceUrl || ch?.url || '');
        if (norm) chapterUrls.add(norm.toLowerCase());
      }
    }

    // Covers flow through the same match vocabulary as raw files. Generic
    // Cover.jpg and Cover.png names stay out so one series cannot clear
    // another's root cover.
    const coverList = Array.isArray(result.covers) ? result.covers : (result.cover ? [result.cover] : []);
    const GENERIC_COVER_FILENAMES = new Set(['cover.jpg', 'cover.png']);

    for (const entry of dirResult.files) {
      if (!entry.is_dir) continue;
      const lowerName = (entry.name || '').toLowerCase();
      if (!shouldRemoveChapters || lowerName === seriesRootName) continue;

      const sidecarPath = `${entry.path}\\gallery.json`;
      let isMatch = false;
      try {
        const sidecarText = await window.__TAURI__.core.invoke('read_text_file', { path: sidecarPath });
        const sidecar = JSON.parse(sidecarText);
        const sidecarId = sidecar?.gallery?.id?.toLowerCase();
        const sidecarUrl = normalizeUrl(sidecar?.sourceUrl || sidecar?.url || '').toLowerCase();

        if (sidecarId && chapterIds.has(sidecarId)) {
          isMatch = true;
        } else if (sidecarUrl && chapterUrls.has(sidecarUrl)) {
          isMatch = true;
        }
      } catch {
        // Not a valid gallery sidecar, skip
      }

      if (isMatch) {
        try {
          await window.__TAURI__.core.invoke('remove_directory', { path: entry.path });
        } catch (err) {
          console.warn('[UrlLoader] Failed to remove matching standalone chapter directory:', entry.path, err);
        }
      }
    }

    if (shouldRemoveCovers && coverList.length > 0) {
      const coverLikes = coverList
        .filter((c) => c && typeof c === 'object')
        .map((c) => ({
          sourceUrl: c.sourceUrl,
          url: c.url,
          hash: c.hash,
          rawFileName: c.rawFileName,
          filename: (typeof c.filename === 'string' && GENERIC_COVER_FILENAMES.has(c.filename.toLowerCase()))
            ? undefined
            : c.filename
        }));
      const sets = buildMatchSets(coverLikes);
      addCoverIdentifiers(sets, coverList, result.title, cleanupPolicy);
      await cleanupRootFiles(providerPath, dirResult.files, sets);
    }

    if (shouldRemoveLooseFiles) {
      const allImages = Array.isArray(result.covers) ? [...result.images, ...result.covers] : result.images;
      await cleanupMatchingRawFiles(providerPath, allImages);
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

  const manifest = await fetchManifest({ refresh: true });
  const entry = findExtractor(url, manifest);
  if (!entry) {
    throw new Error('No extractor available for this site');
  }

  const mod = await loadExtractorModule(entry);
  if (!mod.match(url)) {
    throw new Error(`Extractor '${entry.id}' does not support this URL`);
  }
  try {
    return await _loadUrlWithLibraryDir(url, mod, entry, await getLibraryDir());
  } catch (err) {
    if (!isLibraryLocationError(err)) throw err;
    // The cached Library root went stale (e.g. the location moved in another
    // window). Refresh it and retry the import once against the live root.
    return await _loadUrlWithLibraryDir(url, mod, entry, await reloadLibraryDir());
  }
}

export function isLibraryLocationError(err) {
  const text = typeof err === 'string' ? err : err?.message || '';
  return /retired|relocation is in progress|pending write was cancelled|Reload QuiviT/i.test(String(text || ''));
}

export function remapLibraryPath(path, oldRoot, newRoot) {
  if (!path || !oldRoot || !newRoot || _pathsEqual(oldRoot, newRoot)) return path;
  return _rebasePath(path, oldRoot, newRoot);
}

async function _loadUrlWithLibraryDir(url, mod, entry, libraryDir) {
  const providerDir = entry.libraryPath;
  const providerPath = `${libraryDir}\\${providerDir}`;

  // Direct media handling (e.g. images and videos)
  const isDirect = (typeof mod.isDirectUrl === 'function' && mod.isDirectUrl(url))
    || isDirectMediaUrl(url);
  if (isDirect) {
    const rawStem = extractUrlStem(url);

    // 1. If direct URL is already recorded in root gallery.json or a chapter gallery, jump directly to that file
    const existingMatch = await findMatchingGalleryImage(providerPath, url, rawStem);
    if (existingMatch) {
      // If the matched file is a 0-byte placeholder, download it eagerly before jumping
      const matchSize = (await _readFileSizes(existingMatch.galleryPath)).get(existingMatch.targetName.toLowerCase());
      if (matchSize !== undefined && matchSize === 0 && existingMatch.image?.sourceUrl) {
        const destPath = `${existingMatch.galleryPath}\\${existingMatch.targetName}`;
        const dlOpts = {};
        if (existingMatch.image.headers) dlOpts.headers = existingMatch.image.headers;
        if (existingMatch.image.decryption?.key) dlOpts.xorKey = existingMatch.image.decryption.key;
        if (existingMatch.image.descramble) dlOpts.descramble = existingMatch.image.descramble;
        try {
          await downloadFile(existingMatch.image.sourceUrl, destPath, dlOpts);
        } catch (err) {
          if (existingMatch.image.fallbackUrl && existingMatch.image.fallbackUrl !== existingMatch.image.sourceUrl) {
            await downloadFile(existingMatch.image.fallbackUrl, destPath, dlOpts).catch(() => {});
          }
        }
      }
      return {
        galleryPath: existingMatch.galleryPath,
        targetName: existingMatch.targetName,
        isDirectMatch: true
      };
    }

    const directInfo = typeof mod.parseDirectUrl === 'function'
      ? await mod.parseDirectUrl(url, { fetchText: fetchRemoteText, fetchBytes: _fetchBytes })
      : null;
    const hash = directInfo?.hash || rawStem;
    const targetFilename = directInfo?.filename || (url.split(/[?#]/)[0].split('/').pop() || 'image.png');
    const rawFilename = directInfo?.rawFileName || (url.split(/[?#]/)[0].split('/').pop() || targetFilename);
    const downloadUrl = directInfo?.url || url;
    _validateImage({ url: downloadUrl, filename: targetFilename }, 0);

    // If parseDirectUrl resolved a new hash, check once more before downloading
    if (hash && hash !== rawStem) {
      const secondMatch = await findMatchingGalleryImage(providerPath, downloadUrl, hash);
      if (secondMatch) {
        const secondSize = (await _readFileSizes(secondMatch.galleryPath)).get(secondMatch.targetName.toLowerCase());
        if (secondSize !== undefined && secondSize === 0 && secondMatch.image?.sourceUrl) {
          const destPath = `${secondMatch.galleryPath}\\${secondMatch.targetName}`;
          const dlOpts = {};
          if (secondMatch.image.headers) dlOpts.headers = secondMatch.image.headers;
          if (secondMatch.image.decryption?.key) dlOpts.xorKey = secondMatch.image.decryption.key;
          if (secondMatch.image.descramble) dlOpts.descramble = secondMatch.image.descramble;
          try {
            await downloadFile(secondMatch.image.sourceUrl, destPath, dlOpts);
          } catch (err) {
            if (secondMatch.image.fallbackUrl && secondMatch.image.fallbackUrl !== secondMatch.image.sourceUrl) {
              await downloadFile(secondMatch.image.fallbackUrl, destPath, dlOpts).catch(() => {});
            }
          }
        }
        return {
          galleryPath: secondMatch.galleryPath,
          targetName: secondMatch.targetName,
          isDirectMatch: true
        };
      }
    }

    // 2. Download raw under the provider root (e.g. Provider/image.png)
    const destPath = `${providerPath}\\${targetFilename}`;
    if (window.__TAURI__) {
      await downloadFile(downloadUrl, destPath);

      // Save metadata to root gallery.json
      await recordRootMediaDownload(providerPath, directInfo?.provider || entry.displayName || entry.id, {
        filename: targetFilename,
        rawFileName: rawFilename,
        hash,
        sourceUrl: url,
        url: downloadUrl
      });

      window.dispatchEvent(new CustomEvent('quivit-library-updated'));
    }

    return {
      galleryPath: providerPath,
      targetName: targetFilename,
      isRaw: true
    };
  }

  const html = url.startsWith('blob:') ? '' : await fetchRemoteText(url);
  const result = await extractGallery(mod, html, url, { fetchText: fetchRemoteText, fetchBytes: _fetchBytes }, entry);

  if (result.isSeries) {
    const seriesPath = [libraryDir, providerDir, ...result.rootRelativePath].join('\\');
    let coverFilename = null;

    if (result.cover?.url && result.cover?.filename) {
      coverFilename = result.cover.filename;
      const coverDestPath = `${seriesPath}\\${coverFilename}`;
      if (window.__TAURI__) {
        try {
          await downloadFile(result.cover.url, coverDestPath);
        } catch (err) {
          console.warn('[UrlLoader] Failed to download series cover:', err);
        }
      }
    }

    if (window.__TAURI__) {
      const seriesSidecar = {
        url,
        provider: result.provider,
        title: result.title || '',
        timestamp: new Date().toISOString(),
        gallery: {
          id: `${entry.id}-series-${result.rootRelativePath.join('-')}`,
          relativePath: result.rootRelativePath,
          extractorId: entry.id,
          extractorVersion: entry.version
        },
        images: coverFilename ? [{
          filename: coverFilename,
          displayName: coverFilename,
          description: 'Series Cover',
          sourceUrl: result.cover?.url || ''
        }] : []
      };

      try {
        await window.__TAURI__.core.invoke('write_text_file', {
          path: `${seriesPath}\\gallery.json`,
          content: JSON.stringify(seriesSidecar, null, 2)
        });
      } catch (err) {
        console.warn('[UrlLoader] Failed to write series gallery.json:', err);
      }

      if (result.metadata) {
        await writeGalleryMetadata(seriesPath, result.metadata);
      }

      if (Array.isArray(result.folders)) {
        const FOLDER_CHUNK_SIZE = 25;
        for (let i = 0; i < result.folders.length; i += FOLDER_CHUNK_SIZE) {
          const chunk = result.folders.slice(i, i + FOLDER_CHUNK_SIZE);
          await Promise.all(chunk.map((folder) => {
            if (!folder?.metadata || !Array.isArray(folder.relativePath)) return Promise.resolve();
            const folderPath = [libraryDir, providerDir, ...folder.relativePath].join('\\');
            return writeGalleryMetadata(folderPath, folder.metadata);
          }));
        }
      }
    }

    if (window.__TAURI__ && Array.isArray(result.chapters)) {
      const CHUNK_SIZE = 25;
      for (let i = 0; i < result.chapters.length; i += CHUNK_SIZE) {
        const chunk = result.chapters.slice(i, i + CHUNK_SIZE);
        await Promise.all(chunk.map(async (chapter) => {
          const chapterPath = [libraryDir, providerDir, ...chapter.relativePath].join('\\');

          // Skip chapters that have already been resolved (have real image data on disk).
          // Only create or overwrite stubs for new chapters or still-unresolved ones.
          let existingSidecar = null;
          try {
            const existingText = await window.__TAURI__.core.invoke('read_text_file', {
              path: `${chapterPath}\\gallery.json`
            });
            existingSidecar = JSON.parse(existingText);
          } catch {
            // No existing sidecar; this is a new chapter.
          }

          const alreadyResolved = existingSidecar && existingSidecar.unresolved !== true
            && Array.isArray(existingSidecar.images) && existingSidecar.images.length > 0;

          if (!alreadyResolved) {
            const chapterImages = Array.isArray(chapter.images) ? chapter.images.map((img) => ({
              filename: img.filename,
              displayName: img.filename,
              description: img.description || img.displayName || '',
              sourceUrl: img.url,
              fallbackUrl: img.fallbackUrl,
              hasSound: typeof img.hasSound === 'boolean' ? img.hasSound : undefined,
              headers: img.headers || undefined,
              decryption: img.decryption || undefined,
              descramble: img.descramble || undefined
            })) : [];

            // Stub covers download next to the stub and record last so they
            // never become the open target. One bad thumbnail must not block
            // the series import, so failures only warn.
            const stubCover = buildStubCoverRecord(chapter.cover);
            if (stubCover) {
              try {
                await downloadFile(chapter.cover.url, `${chapterPath}\\${stubCover.filename}`);
              } catch (err) {
                console.warn('[UrlLoader] Failed to download chapter stub cover:', err);
              }
            }

            const stubSidecar = {
              url: chapter.sourceUrl,
              provider: result.provider,
              title: chapter.title || '',
              timestamp: new Date().toISOString(),
              gallery: {
                id: chapter.id,
                relativePath: chapter.relativePath,
                extractorId: entry.id,
                extractorVersion: entry.version
              },
              unresolved: chapterImages.length === 0,
              sourceUrl: chapter.sourceUrl,
              images: stubCover ? [...chapterImages, stubCover] : chapterImages
            };
            await window.__TAURI__.core.invoke('write_text_file', {
              path: `${chapterPath}\\gallery.json`,
              content: JSON.stringify(stubSidecar, null, 2)
            });
            if (chapterImages.length > 0) {
              await window.__TAURI__.core.invoke('create_placeholder_files', {
                dir: chapterPath,
                filenames: chapterImages.map((img) => img.filename)
              }).catch(() => {});
            }
          }

          // Always refresh metadata regardless of resolution state
          if (chapter.metadata) {
            await writeGalleryMetadata(chapterPath, chapter.metadata);
          }
        }));
      }
      window.dispatchEvent(new CustomEvent('quivit-library-updated'));
    }

    // Shape-based cleanup for series: clear matching standalone chapter dirs and loose covers from provider root
    await cleanupMatchingProviderEntries(providerPath, result);

    const state = _Core?.getState?.();
    const openFirstImage = state?.config?.frontend_data?.open_first_image === true;
    const targetName = (openFirstImage && coverFilename) ? coverFilename : null;

    return { galleryPath: seriesPath, result, targetName };
  }

  // Pagination: follow nextPageUrl until exhausted or safety cap reached.
  let pages = 0;
  let nextUrl = result.nextPageUrl;
  while (nextUrl && pages < MAX_PAGINATION_PAGES) {
    const pageHtml = await fetchRemoteText(nextUrl);
    const pageResult = await extractGallery(mod, pageHtml, nextUrl, { fetchText: fetchRemoteText, fetchBytes: _fetchBytes }, entry);
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

  // If this gallery already exists locally, update it additively instead of bailing out.
  // Full reorder: the fresh result.images becomes the authoritative order. Download status
  // is determined from file sizes on disk (size > 0 means already downloaded).
  const existingGallery = await findMatchingGalleryBySourceUrl(providerPath, url, result.gallery?.id);
  if (existingGallery) {
    const existingPath = existingGallery.galleryPath;
    const existingSidecar = existingGallery.sidecar;
    const sizeMap = await _readFileSizes(existingPath);

    const updatedSidecar = {
      url,
      provider: result.provider,
      title: result.title || existingSidecar?.title || '',
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
        sourceUrl: img.url,
        fallbackUrl: img.fallbackUrl,
        hasSound: typeof img.hasSound === 'boolean' ? img.hasSound : undefined,
        headers: img.headers || undefined,
        decryption: img.decryption || undefined,
        descramble: img.descramble || undefined
      }))
    };

    if (window.__TAURI__) {
      await window.__TAURI__.core.invoke('write_text_file', {
        path: `${existingPath}\\gallery.json`,
        content: JSON.stringify(updatedSidecar, null, 2)
      });
      await _ensureIntermediateSidecars(existingPath, result.gallery.id, result.gallery.relativePath, { provider: result.provider, entry });
      if (result.metadata) {
        await writeGalleryMetadata(existingPath, result.metadata);
      }
      if (Array.isArray(result.folders)) {
        for (const folder of result.folders) {
          if (!folder?.metadata || !Array.isArray(folder.relativePath)) continue;
          const folderPath = [libraryDir, providerDir, ...folder.relativePath].join('\\');
          await writeGalleryMetadata(folderPath, folder.metadata);
        }
      }

      // Create placeholders for any new images not yet on disk
      const newFilenames = result.images
        .filter((img) => !sizeMap.has(img.filename.toLowerCase()))
        .map((img) => img.filename);
      if (newFilenames.length > 0) {
        await window.__TAURI__.core.invoke('create_placeholder_files', {
          dir: existingPath,
          filenames: newFilenames
        });
      }
    }

    // Build download items with status derived from disk
    const downloadItems = result.images.map((img, i) => {
      const fileSize = sizeMap.get(img.filename.toLowerCase());
      return {
        url: img.url,
        fallbackUrl: img.fallbackUrl,
        destPath: `${existingPath}\\${img.filename}`,
        filename: img.filename,
        galleryIndex: i,
        status: (fileSize !== undefined && fileSize > 0) ? 'completed' : 'pending',
        headers: img.headers || null,
        decryption: img.decryption || null,
        descramble: img.descramble || null
      };
    });

    const targetItem = result.targetFilename
      ? downloadItems.find((item) => (item.filename || '').toLowerCase() === result.targetFilename.toLowerCase())
      : null;

    const _eagerDownloadExisting = async (item) => {
      const dlOpts = {};
      if (item.headers) dlOpts.headers = item.headers;
      if (item.decryption?.key) dlOpts.xorKey = item.decryption.key;
      if (item.descramble) dlOpts.descramble = item.descramble;
      try {
        await downloadFile(item.url, item.destPath, dlOpts);
        item.status = 'completed';
      } catch (err) {
        const fallback = item.fallbackUrl || null;
        if (fallback && fallback !== item.url) {
          try {
            await downloadFile(fallback, item.destPath, dlOpts);
            item.status = 'completed';
            return;
          } catch (fallbackErr) {
            console.warn('[UrlLoader] Eager download failed with fallback:', fallbackErr);
          }
        }
        console.warn('[UrlLoader] Eager download failed:', err);
      }
    };

    if (targetItem && targetItem.status === 'pending') {
      await _eagerDownloadExisting(targetItem);
    } else if (!targetItem && downloadItems.length > 0 && downloadItems[0].status === 'pending') {
      await _eagerDownloadExisting(downloadItems[0]);
    }

    const hasPending = downloadItems.some((i) => i.status === 'pending');
    if (hasPending) {
      const initialTarget = (targetItem && targetItem.status === 'pending')
        ? targetItem.destPath
        : (downloadItems.find((i) => i.status === 'pending')?.destPath || null);
      _startGalleryQueue(existingPath, downloadItems, { initialTarget });
    }

    await cleanupMatchingProviderEntries(providerPath, result);
    window.dispatchEvent(new CustomEvent('quivit-library-updated'));

    return {
      galleryPath: existingPath,
      result,
      targetName: result.targetFilename || null
    };
  }

  const galleryPath = [libraryDir, providerDir, ...result.gallery.relativePath].join('\\');

  await ensureGalleryOwnership(galleryPath, result.gallery, url);

  // Write gallery.json sidecar first so the directory is recognized as a gallery immediately
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
      sourceUrl: img.url,
      fallbackUrl: img.fallbackUrl,
      hasSound: typeof img.hasSound === 'boolean' ? img.hasSound : undefined,
      headers: img.headers || undefined,
      decryption: img.decryption || undefined,
      descramble: img.descramble || undefined
    }))
  };

  if (window.__TAURI__) {
    await window.__TAURI__.core.invoke('write_text_file', {
      path: `${galleryPath}\\gallery.json`,
      content: JSON.stringify(sidecar, null, 2)
    });
    if (result.metadata) {
      await writeGalleryMetadata(galleryPath, result.metadata);
    }
    if (Array.isArray(result.folders)) {
      for (const folder of result.folders) {
        if (!folder?.metadata || !Array.isArray(folder.relativePath)) continue;
        const folderPath = [libraryDir, providerDir, ...folder.relativePath].join('\\');
        await writeGalleryMetadata(folderPath, folder.metadata);
      }
    }
    await _ensureIntermediateSidecars(galleryPath, result.gallery.id, result.gallery.relativePath, { provider: result.provider, entry });
  }

  // Prepopulate all gallery files as 0-byte placeholders on disk upfront
  if (window.__TAURI__) {
    const filenames = result.images.map((img) => img.filename);
    await window.__TAURI__.core.invoke('create_placeholder_files', {
      dir: galleryPath,
      filenames
    });
  }

  const state = _Core?.getState?.();
  const openFirstImage = state?.config?.frontend_data?.open_first_image === true;

  const downloadItems = result.images.map((img, i) => ({
    url: img.url,
    fallbackUrl: img.fallbackUrl,
    destPath: `${galleryPath}\\${img.filename}`,
    filename: img.filename,
    galleryIndex: i,
    status: 'pending',
    headers: img.headers || null,
    decryption: img.decryption || null,
    descramble: img.descramble || null
  }));

  const targetItem = result.targetFilename
    ? downloadItems.find((item) => (item.filename || '').toLowerCase() === result.targetFilename.toLowerCase())
    : null;

  const _eagerDownload = async (item) => {
    const dlOpts = {};
    if (item.headers) dlOpts.headers = item.headers;
    if (item.decryption?.key) dlOpts.xorKey = item.decryption.key;
    if (item.descramble) dlOpts.descramble = item.descramble;
    try {
      await downloadFile(item.url, item.destPath, dlOpts);
      item.status = 'completed';
    } catch (err) {
      const fallback = item.fallbackUrl || null;
      if (fallback && fallback !== item.url) {
        try {
          await downloadFile(fallback, item.destPath, dlOpts);
          item.status = 'completed';
          return;
        } catch (fallbackErr) {
          console.warn('[UrlLoader] Eager download failed with fallback:', fallbackErr);
        }
      }
      console.warn('[UrlLoader] Eager download failed:', err);
    }
  };

  if (targetItem) {
    await _eagerDownload(targetItem);
  } else if (downloadItems.length > 0) {
    await _eagerDownload(downloadItems[0]);
  }

  // Shape-based cleanup for standard gallery: prune matching standalone raw files under provider root
  await cleanupMatchingProviderEntries(providerPath, result);

  // Background queue for remaining images
  if (downloadItems.length > 0) {
    const initialTarget = targetItem
      ? (downloadItems.find((i) => i.status === 'pending')?.destPath || null)
      : (downloadItems[1]?.destPath || downloadItems[0].destPath);
    _startGalleryQueue(galleryPath, downloadItems, { initialTarget });
  } else {
    _activeGalleryPath = galleryPath;
    _activeGalleryItems = downloadItems;
  }

  window.dispatchEvent(new CustomEvent('quivit-library-updated'));

  const targetName = targetItem
    ? targetItem.filename
    : (openFirstImage ? (result.images[0]?.filename || null) : null);
  return { galleryPath, result, targetName };
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

// -- File size reading for download status determination --

async function _readFileSizes(galleryPath) {
  if (!window.__TAURI__) return new Map();
  try {
    const dirResult = await window.__TAURI__.core.invoke('read_directory', {
      path: galleryPath, showHidden: false
    });
    const sizeMap = new Map();
    for (const entry of dirResult?.files || []) {
      if (entry.name) sizeMap.set(entry.name.toLowerCase(), entry.size ?? 0);
    }
    return sizeMap;
  } catch {
    return new Map();
  }
}

// -- Gallery queue management and auto-resumption --

function _startGalleryQueue(galleryPath, items, options = {}) {
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
  if (initialVisibleEnd <= initialVisibleStart) {
    const state = _Core?.getState?.();
    const activeIdx = (state?.directory && _pathsEqual(state.directory, galleryPath) && typeof state.index === 'number' && state.index >= 0)
      ? state.index
      : 0;
    initialVisibleStart = activeIdx;
    initialVisibleEnd = Math.min(items.length, activeIdx + 2);
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
  let prioritizedTarget = null;
  if (options.initialTarget) {
    prioritizedTarget = options.initialTarget;
  } else if (state?.directory && _pathsEqual(state.directory, galleryPath) && state.list?.[state.index]) {
    const currentEntry = state.list[state.index];
    const targetPath = currentEntry?.path || (currentEntry?.name ? `${galleryPath}\\${currentEntry.name}` : null);
    if (targetPath && !currentEntry.is_parent) {
      prioritizedTarget = targetPath;
    }
  }

  if (prioritizedTarget) {
    _activeQueue.prioritize(prioritizedTarget);
  } else {
    const firstPending = items.find(i => i.status === 'pending');
    if (firstPending) {
      _activeQueue.prioritize(firstPending.destPath);
    }
  }

  _activeQueue.start().catch((err) => {
    console.warn('[UrlLoader] Download queue error:', err);
  });
}

export async function resolveUnresolvedGallery(galleryPath) {
  if (!galleryPath || !window.__TAURI__) return false;
  if (_resolvingGalleries.has(galleryPath)) return false;
  if (_libraryDirCache && !_isPathWithin(galleryPath, _libraryDirCache)) {
    return false;
  }

  const sidecarPath = `${galleryPath}\\gallery.json`;
  let content = null;
  try {
    content = await window.__TAURI__.core.invoke('read_text_file', { path: sidecarPath });
  } catch {
    return false;
  }
  if (!content) return false;

  let data = null;
  try {
    data = JSON.parse(content);
  } catch {
    return false;
  }
  if (!data?.unresolved || !data?.sourceUrl) return false;

  _resolvingGalleries.add(galleryPath);
  try {
    let entry = findExtractor(data.sourceUrl, await fetchManifest());
    if (!entry) {
      entry = findExtractor(data.sourceUrl, await fetchManifest({ refresh: true }));
    }
    if (!entry) return false;
    const mod = await loadExtractorModule(entry);
    const fullResult = await extractGallery(mod, '', data.sourceUrl, { fetchText: fetchRemoteText, fetchBytes: _fetchBytes }, entry);
    if (!fullResult?.images || fullResult.images.length === 0) return false;

    const updatedSidecar = {
      url: data.sourceUrl,
      provider: fullResult.provider,
      title: fullResult.title || data.title || '',
      timestamp: new Date().toISOString(),
      gallery: {
        id: fullResult.gallery?.id || data.gallery?.id,
        relativePath: data.gallery?.relativePath || fullResult.gallery?.relativePath,
        extractorId: entry.id,
        extractorVersion: entry.version
      },
      images: fullResult.images.map((img) => ({
        filename: img.filename,
        displayName: img.filename,
        description: img.description || img.displayName || '',
        sourceUrl: img.url,
        fallbackUrl: img.fallbackUrl,
        hasSound: typeof img.hasSound === 'boolean' ? img.hasSound : undefined,
        headers: img.headers || undefined,
        decryption: img.decryption || undefined,
        descramble: img.descramble || undefined
      }))
    };

    await window.__TAURI__.core.invoke('write_text_file', {
      path: sidecarPath,
      content: JSON.stringify(updatedSidecar, null, 2)
    });
    await _ensureIntermediateSidecars(galleryPath, fullResult.gallery?.id || data.gallery?.id, data.gallery?.relativePath || fullResult.gallery?.relativePath, { provider: fullResult.provider, entry });

    if (fullResult.metadata) {
      await writeGalleryMetadata(galleryPath, fullResult.metadata);
    }

    const filenames = fullResult.images.map((img) => img.filename);
    await window.__TAURI__.core.invoke('create_placeholder_files', {
      dir: galleryPath,
      filenames
    });

    const eagerImg = fullResult.targetFilename
      ? fullResult.images.find((img) => img.filename.toLowerCase() === fullResult.targetFilename.toLowerCase())
      : (fullResult.images[0] || null);

    if (eagerImg) {
      const dlOpts = {};
      if (eagerImg.headers) dlOpts.headers = eagerImg.headers;
      if (eagerImg.decryption?.key) dlOpts.xorKey = eagerImg.decryption.key;
      if (eagerImg.descramble) dlOpts.descramble = eagerImg.descramble;
      try {
        await downloadFile(eagerImg.url, `${galleryPath}\\${eagerImg.filename}`, dlOpts);
      } catch (err) {
        const fallback = eagerImg.fallbackUrl || null;
        if (fallback && fallback !== eagerImg.url) {
          try {
            await downloadFile(fallback, `${galleryPath}\\${eagerImg.filename}`, dlOpts);
          } catch (fallbackErr) {
            console.warn('[UrlLoader] Failed to eagerly download first image with fallback:', fallbackErr);
          }
        } else {
          console.warn('[UrlLoader] Failed to eagerly download first image:', err);
        }
      }
    }

    return true;
  } finally {
    _resolvingGalleries.delete(galleryPath);
  }
}

export async function resumeGalleryDownloads(galleryPath, list) {
  if (!galleryPath || !window.__TAURI__) return false;
  if (_activeQueue && _activeQueue.isActive && _pathsEqual(_activeGalleryPath, galleryPath)) {
    return true;
  }
  if (_resolvingGalleries.has(galleryPath)) {
    return false;
  }
  if (_resumingGalleries.has(galleryPath)) {
    return _resumingGalleries.get(galleryPath);
  }

  const resumePromise = (async () => {
    try {
      const sidecarPath = `${galleryPath}\\gallery.json`;
      let content = await window.__TAURI__.core.invoke('read_text_file', { path: sidecarPath });
      if (!content) return false;

      let data = JSON.parse(content);
      if (!data) return false;

      if (data.unresolved && data.sourceUrl) {
        const resolved = await resolveUnresolvedGallery(galleryPath);
        if (!resolved) return false;

        content = await window.__TAURI__.core.invoke('read_text_file', { path: sidecarPath });
        data = JSON.parse(content);

        if (_FsUtils?.refresh && _pathsEqual(_Core?.getState?.()?.directory, galleryPath)) {
          await _FsUtils.refresh();
          const freshList = _Core?.getState?.()?.list;
          if (Array.isArray(freshList)) {
            list = freshList;
          }
        }
      }

      if (!Array.isArray(data.images) || data.images.length === 0) {
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
          fallbackUrl: img.fallbackUrl,
          destPath,
          galleryIndex: index,
          status: isDownloaded ? 'completed' : 'pending',
          headers: img.headers || null,
          decryption: img.decryption || null,
          descramble: img.descramble || null
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
    } finally {
      _resumingGalleries.delete(galleryPath);
    }
  })();

  _resumingGalleries.set(galleryPath, resumePromise);
  return resumePromise;
}

// -- Placeholder and bridging queries --

// After a file is moved to the Recycle Bin, drop its record from the parent
// gallery sidecar so resume and reimport stop treating it as missing and
// refetching it. Directories need nothing: their sidecar goes with them.
export async function forgetDeletedLibraryEntry(deletedPath) {
  if (!window.__TAURI__ || !deletedPath) return false;
  const normalized = String(deletedPath).replace(/\//g, '\\');
  const sepIdx = normalized.lastIndexOf('\\');
  if (sepIdx < 0) return false;
  const fileName = normalized.slice(sepIdx + 1).toLowerCase();
  if (!fileName) return false;
  const sidecarPath = `${normalized.slice(0, sepIdx)}\\gallery.json`;
  let data = null;
  try {
    data = JSON.parse(await window.__TAURI__.core.invoke('read_text_file', { path: sidecarPath }));
  } catch {
    return false;
  }
  if (!data || !Array.isArray(data.images)) return false;
  const kept = data.images.filter((img) => (img?.filename || '').toLowerCase() !== fileName);
  if (kept.length === data.images.length) return false;
  data.images = kept;
  try {
    await window.__TAURI__.core.invoke('write_text_file', {
      path: sidecarPath,
      content: JSON.stringify(data, null, 2)
    });
  } catch (err) {
    console.warn('[UrlLoader] Failed to prune deleted file from gallery sidecar:', err);
    return false;
  }
  return true;
}

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

export function getGalleryDownloadStatus(filePath) {
  if (!_activeQueue || !_activeQueue.isActive || !_activeGalleryPath || !filePath) return null;
  return _activeQueue.getStatus(filePath);
}

export function retryGalleryDownload(filePath) {
  if (!_activeQueue || !_activeQueue.isActive || !_activeGalleryPath || !filePath) return false;
  if (_activeQueue.getStatus(filePath) !== 'error') return false;
  _activeQueue.prioritize(filePath);
  return true;
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

export function handleLibraryRelocation({ oldPath, libraryPath } = {}) {
  const previousPath = oldPath || _libraryDirCache;
  const nextPath = libraryPath || _libraryDirCache;
  _libraryDirCache = nextPath || null;

  if (!previousPath || !nextPath || _pathsEqual(previousPath, nextPath)) {
    window.dispatchEvent(new CustomEvent('quivit-library-updated'));
    return { oldPath: previousPath || '', libraryPath: nextPath || '', changed: false };
  }

  _teardownActiveQueue();
  window.dispatchEvent(new CustomEvent('quivit-library-updated'));

  const state = _Core?.getState?.();
  if (state?.directory && _isPathWithin(state.directory, previousPath) && _FsUtils) {
    const remappedDirectory = _rebasePath(state.directory, previousPath, nextPath);
    const targetName = state.list?.[state.index]?.name || state.filename || '';
    _FsUtils.loadFile(remappedDirectory, {
      history: 'skip',
      targetName,
      restoreLastImage: false
    }).catch(err => {
      console.error('[UrlLoader] Failed to open the relocated Library directory:', err);
    });
  }

  return { oldPath: previousPath, libraryPath: nextPath, changed: true };
}

export async function prepareGalleryDirectory(galleryPath, options = {}) {
  if (!galleryPath || !window.__TAURI__) return false;

  const sidecarPath = `${galleryPath}\\gallery.json`;
  let content = null;
  try {
    content = await window.__TAURI__.core.invoke('read_text_file', { path: sidecarPath });
  } catch {
    return false;
  }
  if (!content) return false;

  let data = null;
  try {
    data = JSON.parse(content);
  } catch {
    return false;
  }

  if (data?.unresolved && data?.sourceUrl) {
    await resolveUnresolvedGallery(galleryPath);
    try {
      content = await window.__TAURI__.core.invoke('read_text_file', { path: sidecarPath });
      data = JSON.parse(content);
    } catch {
      return false;
    }
  }

  if (!Array.isArray(data?.images) || data.images.length === 0) return false;

  let targetImg = null;
  if (options?.targetName) {
    const cleanTarget = options.targetName.toLowerCase();
    targetImg = data.images.find((img) => (img.filename || '').toLowerCase() === cleanTarget);
  }
  if (!targetImg) {
    targetImg = data.images[0];
  }
  if (!targetImg || (!targetImg.sourceUrl && !targetImg.url)) return false;

  const sizeMap = await _readFileSizes(galleryPath);
  const targetSize = sizeMap.get((targetImg.filename || '').toLowerCase());

  if (targetSize === undefined || targetSize === 0) {
    const destPath = `${galleryPath}\\${targetImg.filename}`;
    const dlOpts = {};
    if (targetImg.headers) dlOpts.headers = targetImg.headers;
    if (targetImg.decryption?.key) dlOpts.xorKey = targetImg.decryption.key;
    if (targetImg.descramble) dlOpts.descramble = targetImg.descramble;
    const downloadUrl = targetImg.sourceUrl || targetImg.url;

    try {
      await downloadFile(downloadUrl, destPath, dlOpts);
    } catch (err) {
      const fallback = targetImg.fallbackUrl || null;
      if (fallback && fallback !== downloadUrl) {
        try {
          await downloadFile(fallback, destPath, dlOpts);
        } catch (fallbackErr) {
          console.warn('[UrlLoader] prepareGalleryDirectory fallback failed:', fallbackErr);
        }
      } else {
        console.warn('[UrlLoader] prepareGalleryDirectory download failed:', err);
      }
    }
  }

  return true;
}

let _getFileListViewportRange = null;

export const UrlLoader = {
  init({ Core, FsUtils, urlOverlay, getFileListViewportRange }) {
    _Core = Core;
    _FsUtils = FsUtils;
    _urlOverlay = urlOverlay;
    _getFileListViewportRange = typeof getFileListViewportRange === 'function' ? getFileListViewportRange : null;
    getLibraryDir().catch(() => {});

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

    // Register directory preparation hook so fsUtils can resolve chapter stubs
    // and eagerly download target/first image before reading directory,
    // eliminating empty file list flashes and 404s.
    if (_FsUtils && typeof _FsUtils.setDirectoryPreparationHook === 'function') {
      _FsUtils.setDirectoryPreparationHook((path, options) => prepareGalleryDirectory(path, options));
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

        // Check if queue is missing or not active for this gallery
        if (!_activeQueue || !_activeQueue.isActive || !_pathsEqual(dir, _activeGalleryPath)) {
          if (dir && !_resumingGalleries.has(dir)) {
            resumeGalleryDownloads(dir, state.list).catch(() => {});
          }
          return;
        }

        if (!state.list || state.index < 0 || state.index >= state.list.length) return;

        const currentEntry = state.list[state.index];
        if (!currentEntry || currentEntry.is_parent) return;

        const targetPath = currentEntry.path || (currentEntry.name ? `${_activeGalleryPath}\\${currentEntry.name}` : null);
        if (targetPath) {
          _activeQueue.prioritize(targetPath);
        }

        if (!state.fileListVisible) {
          const total = state.list.length;
          const vStart = Math.max(0, state.index);
          const vEnd = Math.min(total, state.index + 2);
          _activeQueue.setVisibleRange(vStart, vEnd);
        }
      });
    }
  },
  openPrompt,
  loadUrl,
  resumeGalleryDownloads,
  resolveUnresolvedGallery,
  prepareGalleryDirectory,
  forgetDeletedLibraryEntry,
  normalizeUrl,
  isValidUrl,
  isGalleryDownloading,
  cancelGalleryDownloads,
  isPlaceholderFile,
  getGalleryDownloadStatus,
  retryGalleryDownload,
  setVisibleRange,
  fetchRemoteText,
  fetchExtractorText,
  downloadFile,
  cancelDownload,
  getLibraryDir,
  reloadLibraryDir,
  getCachedLibraryDir,
  remapLibraryPath,
  isLibraryLocationError,
  handleLibraryRelocation,
  fetchManifest,
  getExtractorCacheKey,
  validateManifest,
  findExtractor,
  loadExtractorModule,
  extractGallery,
  validateExtractorResult,
  findMatchingGalleryImage,
  findMatchingGalleryBySourceUrl,
  buildMatchSets,
  addCoverIdentifiers,
  matchSidecarRecord,
  cleanupMatchingRawFiles,
  cleanupMatchingProviderEntries,
  PREFETCH_START_THRESHOLD_PERCENT,
  DownloadQueue
};
