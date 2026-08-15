import { fetchMetadata } from '../metadata.js';

let _lastMetadataArchive = null;
let _currentMeta = null;
let _badgeEl = null;

function _generateCoverThumbnail(src) {
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
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = reject;
    img.src = src;
  });
}

async function _loadMetadataForArchive(archivePath, metaFiles, fileList, FsUtils) {
  if (archivePath === _lastMetadataArchive) return;
  _lastMetadataArchive = archivePath;
  _currentMeta = null;
  if (_badgeEl) _badgeEl.classList.add('hidden');

  const meta = await fetchMetadata(archivePath, metaFiles);
  if (_lastMetadataArchive !== archivePath) return;

  _currentMeta = meta;
  if (meta) {
    if (_badgeEl) _badgeEl.classList.remove('hidden');
    const firstImage = fileList.find(f => f && !f.is_dir && /\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(f.name));
    const coverSrc = firstImage ? FsUtils.buildArchiveSrc(archivePath, firstImage.name) : null;

    let coverDataUrl = null;
    if (coverSrc) {
      try {
        coverDataUrl = await _generateCoverThumbnail(coverSrc);
      } catch (_) {}
    }
    const payload = { meta, coverSrc: coverDataUrl || coverSrc };
    try { localStorage.setItem('quivit-metadata-current', JSON.stringify(payload)); } catch (_) {}
    if (window.__TAURI__) {
      window.__TAURI__.event.emit('metadata-data', payload).catch(() => {});
    }
  } else {
    try { localStorage.removeItem('quivit-metadata-current'); } catch (_) {}
  }
}

export async function openMetadataWindow() {
  if (!_currentMeta || !window.__TAURI__) return;
  await window.__TAURI__.core.invoke('open_metadata_window').catch(console.error);
}

export function initMetadataBadge({ Core, FsUtils, badgeEl }) {
  _badgeEl = badgeEl;

  if (_badgeEl) {
    _badgeEl.addEventListener('click', () => openMetadataWindow());
    _badgeEl.addEventListener('keydown', (e) => { 
      if (e.key === 'Enter' || e.key === ' ') { 
        e.preventDefault(); 
        openMetadataWindow(); 
      } 
    });
  }

  Core.onStateChange((state) => {
    if (state.mode === 'archive' && state.archivePath) {
      _loadMetadataForArchive(state.archivePath, state.archiveMetadataFiles || [], state.list, FsUtils).catch(console.error);
    } else if (state.mode !== 'archive') {
      _lastMetadataArchive = null;
      _currentMeta = null;
      if (_badgeEl) _badgeEl.classList.add('hidden');
      try { localStorage.removeItem('quivit-metadata-current'); } catch (_) {}
    }
  });
}
