import { fetchMetadata, fetchDirectoryMetadata } from '../metadata.js';
import { workspaceSurface, hostsWorkspaceSurface } from '../shared/workspaceHost.js';
import { registerMetadataStateProvider, getSessionMetadataState } from '../shared/workspaceSession.js';

let _lastMetadataArchive = null;
let _lastMetadataDir = null;
let _currentMeta = null;
let _hasMetadata = false;
let _loadSeq = 0;
let _badgeEl = null;

function _syncBadgeVisibility(state) {
  if (!_badgeEl) return;
  _badgeEl.classList.toggle('is-visible', Boolean(_hasMetadata && hostsWorkspaceSurface('fileList', state)));
}

function _notifyMetadataAvailability(hasMetadata, state) {
  const next = Boolean(hasMetadata);
  const changed = _hasMetadata !== next;
  _hasMetadata = next;
  _syncBadgeVisibility(state);
  if (changed && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('quivit-metadata-changed', { detail: { hasMetadata: next } }));
  }
}

function _clearMetadataState(state) {
  _currentMeta = null;
  try { localStorage.removeItem('quivit-metadata-current'); } catch (_) {}
  _notifyMetadataAvailability(false, state);
}

function _readStoredMetadataAvailability() {
  try {
    const raw = localStorage.getItem('quivit-metadata-current');
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return Boolean(parsed && parsed.meta);
  } catch (_) {
    return false;
  }
}

function _generateCoverThumbnail(src, usePng) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const MAX_H = 300;
      const scale = Math.min(1, MAX_H / img.naturalHeight);
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      resolve(usePng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = reject;
    img.src = src;
  });
}

async function _loadMetadataForArchive(archivePath, metaFiles, fileList, FsUtils, Core) {
  if (archivePath === _lastMetadataArchive) return;
  _lastMetadataArchive = archivePath;
  _lastMetadataDir = null;
  _currentMeta = null;
  const seq = ++_loadSeq;

  const meta = await fetchMetadata(archivePath, metaFiles);
  if (seq !== _loadSeq || _lastMetadataArchive !== archivePath) return;

  if (meta) {
    _currentMeta = meta;
    try { localStorage.setItem('quivit-metadata-current', JSON.stringify({ meta, coverSrc: null })); } catch (_) {}
    _notifyMetadataAvailability(true, Core?.getState?.());

    const firstImage = fileList.find(f => FsUtils.isImageEntry(f));
    const coverSrc = firstImage ? FsUtils.buildArchiveSrc(archivePath, firstImage.name) : null;

    let coverDataUrl = null;
    if (coverSrc) {
      try {
        const isIco = firstImage ? FsUtils.isIco(firstImage.name || '') : false;
        coverDataUrl = await _generateCoverThumbnail(coverSrc, isIco);
      } catch (_) {}
    }
    if (seq !== _loadSeq || _lastMetadataArchive !== archivePath) return;

    const payload = { meta, coverSrc: coverDataUrl || coverSrc };
    try { localStorage.setItem('quivit-metadata-current', JSON.stringify(payload)); } catch (_) {}
    if (window.__TAURI__) {
      window.__TAURI__.event.emit('metadata-data', payload).catch(() => {});
    }
  } else {
    _clearMetadataState(Core?.getState?.());
  }
}

async function _loadMetadataForDirectory(directory, fileList, FsUtils, Core) {
  if (directory === _lastMetadataDir) return;
  _lastMetadataDir = directory;
  _lastMetadataArchive = null;
  _currentMeta = null;
  const seq = ++_loadSeq;

  const res = await fetchDirectoryMetadata(directory);
  if (seq !== _loadSeq || _lastMetadataDir !== directory) return;

  if (res && res.meta) {
    _currentMeta = res.meta;
    try { localStorage.setItem('quivit-metadata-current', JSON.stringify({ meta: res.meta, coverSrc: null })); } catch (_) {}
    _notifyMetadataAvailability(true, Core?.getState?.());

    const firstImage = fileList.find(f => FsUtils.isImageEntry(f));
    const rawCoverSrc = firstImage ? await FsUtils.buildFileSrc(firstImage.path) : null;
    if (seq !== _loadSeq || _lastMetadataDir !== directory) return;

    const coverSrc = rawCoverSrc ? FsUtils.firstIcoSrc(rawCoverSrc) : null;

    let coverDataUrl = null;
    if (coverSrc) {
      try {
        coverDataUrl = await _generateCoverThumbnail(coverSrc, Array.isArray(rawCoverSrc));
      } catch (_) {}
    }
    if (seq !== _loadSeq || _lastMetadataDir !== directory) return;

    const payload = { meta: res.meta, coverSrc: coverDataUrl || coverSrc };
    try { localStorage.setItem('quivit-metadata-current', JSON.stringify(payload)); } catch (_) {}
    if (window.__TAURI__) {
      window.__TAURI__.event.emit('metadata-data', payload).catch(() => {});
    }
  } else {
    _clearMetadataState(Core?.getState?.());
  }
}

export async function openMetadataWindow() {
  if ((!_hasMetadata && !_currentMeta) || !window.__TAURI__) return;
  await window.__TAURI__.core.invoke('open_metadata_window').catch(console.error);
}

export function initMetadataBadge({ Core, FsUtils, badgeEl }) {
  _badgeEl = badgeEl;

  if (_badgeEl) {
    _badgeEl.addEventListener('click', () => openMetadataWindow());
    _badgeEl.addEventListener('keydown', (e) => { 
      if (!e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'Enter' || e.key === ' ')) { 
        e.preventDefault(); 
        openMetadataWindow(); 
      } 
    });
  }

  if (workspaceSurface) {
    const sessionAvailable = getSessionMetadataState();
    _hasMetadata = typeof sessionAvailable === 'boolean'
      ? sessionAvailable
      : _readStoredMetadataAvailability();
    _syncBadgeVisibility(Core.getState());
    window.addEventListener('quivit-metadata-changed', (e) => {
      _hasMetadata = Boolean(e?.detail?.hasMetadata);
      _syncBadgeVisibility(Core.getState());
    });
    Core.onStateChange((state) => {
      _syncBadgeVisibility(state);
    });
    return;
  }

  registerMetadataStateProvider(() => _hasMetadata);

  Core.onStateChange((state) => {
    _syncBadgeVisibility(state);
    const archiveLocked = state.archiveEncryption === 'password_required' || state.archiveEncryption === 'password_incorrect';
    if (state.mode === 'archive' && state.archivePath && !archiveLocked) {
      _lastMetadataDir = null;
      _loadMetadataForArchive(state.archivePath, state.archiveMetadataFiles || [], state.list, FsUtils, Core).catch(console.error);
    } else if (state.mode === 'image' && state.directory) {
      _lastMetadataArchive = null;
      _loadMetadataForDirectory(state.directory, state.list, FsUtils, Core).catch(console.error);
    } else {
      ++_loadSeq;
      _lastMetadataArchive = null;
      _lastMetadataDir = null;
      _clearMetadataState(state);
    }
  });
}
