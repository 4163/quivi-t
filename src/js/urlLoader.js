/**
 * urlLoader.js: orchestrator for loading remote galleries via URL.
 *
 * Coordinates URL prompt interaction, remote text/image retrieval
 * via backend network commands, and gallery state management.
 */

let _urlOverlay = null;
let _Core = null;
let _FsUtils = null;

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

export async function loadUrl(urlString) {
  if (!isValidUrl(urlString)) {
    throw new Error('Please enter a valid URL');
  }

  // Placeholder for extractor matching and download queue execution.
  // Extractor authoring and queue execution will be wired in the next slice.
  return { url: urlString.trim() };
}

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
  downloadFile
};
