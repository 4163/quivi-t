/**
 * urlLoader.js: orchestrator for loading remote galleries via URL.
 *
 * Fetches a remote manifest, matches user URLs to site-specific
 * extractors, loads extractor modules via Blob URL + dynamic import(),
 * and coordinates page fetching and gallery extraction.
 */

import { BoundedMap } from './services/cache.js';

const MANIFEST_URL = 'https://raw.githubusercontent.com/4163/quivi-t/main/extractors/manifest.json';
const EXTRACTOR_MODULE_CACHE_CAPACITY = 20;
export const MAX_PAGINATION_PAGES = 50;

let _urlOverlay = null;
let _Core = null;
let _FsUtils = null;
let _manifestCache = null;

// Blob URLs tracked separately for revocation on cache eviction.
const _blobUrls = new Map();
const _extractorCache = new BoundedMap(EXTRACTOR_MODULE_CACHE_CAPACITY, (id) => {
  const url = _blobUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    _blobUrls.delete(id);
  }
});

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

// -- Network proxy --

export async function fetchRemoteText(url) {
  if (!window.__TAURI__) {
    throw new Error('Backend network proxy unavailable in browser environment');
  }
  return await window.__TAURI__.core.invoke('fetch_text', { url });
}

export async function downloadFile(url, destPath) {
  if (!window.__TAURI__) {
    throw new Error('Backend network proxy unavailable in browser environment');
  }
  return await window.__TAURI__.core.invoke('download_to_file', { url, destPath });
}

// -- Manifest and extractor matching --

export async function fetchManifest() {
  if (_manifestCache) return _manifestCache;

  const text = await fetchRemoteText(MANIFEST_URL);
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

  const sourceUrl = MANIFEST_URL.replace(/[^/]+$/, entry.source);
  const source = await fetchRemoteText(sourceUrl);

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

export function extractGallery(extractor, html, url) {
  const result = extractor.extract(html, url);

  if (!result || typeof result.provider !== 'string') {
    throw new Error("Extractor returned invalid result: missing 'provider' field");
  }
  if (!Array.isArray(result.images)) {
    throw new Error("Extractor returned invalid result: 'images' must be an array");
  }

  return result;
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
  const result = extractGallery(mod, html, url);

  // Pagination: follow nextPageUrl until exhausted or safety cap reached.
  let pages = 0;
  let nextUrl = result.nextPageUrl;
  while (nextUrl && pages < MAX_PAGINATION_PAGES) {
    const pageHtml = await fetchRemoteText(nextUrl);
    const pageResult = extractGallery(mod, pageHtml, nextUrl);
    result.images.push(...pageResult.images);
    nextUrl = pageResult.nextPageUrl;
    pages++;
  }
  result.nextPageUrl = null;

  return result;
}

// -- UI integration --

export function openPrompt() {
  if (_urlOverlay) {
    _urlOverlay.show();
  }
}

export const UrlLoader = {
  init({ Core, FsUtils, urlOverlay }) {
    _Core = Core;
    _FsUtils = FsUtils;
    _urlOverlay = urlOverlay;
  },
  openPrompt,
  loadUrl,
  isValidUrl,
  fetchRemoteText,
  downloadFile,
  fetchManifest,
  findExtractor,
  loadExtractorModule,
  extractGallery
};
