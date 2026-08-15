/**
 * main.js - main window DOM wiring.
 */

import { Core } from './core.js';
import { FsUtils } from './fsUtils.js';
import { Viewer } from './viewer/viewer.js';
import * as NavigationHistory from './navigationHistory.js';
import { initFilePanel, toggleFavoriteCurrent, getHighlightedFavorite, navigateHighlightedFavorite } from './filepanel/filePanel.js';
import { bindKeyboardShortcuts, updateMenuShortcuts, resetScrollLatch, syncScrollLatch } from './shortcuts.js';
import { normalizeCombo, formatKeyName, normalizeList } from './services/keyCombo.js';
import { applyTheme, applyCustomCss } from './shared/theme.js';
import { DEFAULT_KEYBOARD_PAN_STEP, DEFAULT_WHEEL_PAN_STEP } from './keybinds.js';
import { Statusbar } from './menubar/statusbar.js';
import {
  initMenuBar,
  closeMenus,
} from './menubar.js';
import * as Chrome from './menubar/chrome.js';
import { fetchMetadata, findMetadataEntry } from './metadata.js';
import { initFullscreen, toggleFullscreen, syncFullscreenState, isFullscreenActive, syncKeyLabel } from './main/fullscreen.js';

import { handleTabJump } from './keyboardNav.js';
import { emergencyCssReset } from './shared/configPreview.js';
import { ACTION_REGISTRY, dispatch } from './services/actions.js';

// Reset the options tab state on app startup so it defaults to General per session
localStorage.removeItem('options-active-tab');

// Emergency CSS Reset (Ctrl+Shift+Alt+C)
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.altKey && e.key.toLowerCase() === 'c') {
    e.preventDefault();
    emergencyCssReset(Core.getState().config);
  }

  // Global Tab Navigation Jump (Home/End)
  handleTabJump(e);
});

const dropOverlay = document.getElementById('drop-overlay');
const menubar = document.getElementById('menubar');
const viewport = document.getElementById('viewport');
const statusbar = document.getElementById('statusbar');

const filePanel = document.getElementById('file-panel');
const filePanelBreadcrumb = document.getElementById('file-panel-breadcrumb');
const fileListUl = document.getElementById('file-list');
const resizeHandle = document.getElementById('panel-resize-handle');
const metadataBadge = document.getElementById('status-metadata-badge');

let activeScaling = '';
let _uiInitialized = false;
let dropMessageTimer = null;
let keyboardPanStep = DEFAULT_KEYBOARD_PAN_STEP;
let wheelPanStep = DEFAULT_WHEEL_PAN_STEP;
const DEFAULT_DROP_MESSAGE = 'Drop files here, or click to open a folder';

// Metadata window state
let _lastMetadataArchive = null; // archive path we last fetched for
let _currentMeta = null;         // last fetched ComicMeta (or null)

async function _loadMetadataForArchive(archivePath, metaFiles, fileList) {
  if (archivePath === _lastMetadataArchive) return; // already loaded
  _lastMetadataArchive = archivePath;
  _currentMeta = null;
  metadataBadge.classList.add('hidden');

  const meta = await fetchMetadata(archivePath, metaFiles);
  if (_lastMetadataArchive !== archivePath) return; // navigated away

  _currentMeta = meta;
  if (meta) {
    metadataBadge.classList.remove('hidden');
    const firstImage = fileList.find(f => f && !f.is_dir && /\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(f.name));
    const coverSrc = firstImage ? FsUtils.buildArchiveSrc(archivePath, firstImage.name) : null;

    // Generate a small thumbnail data URL so the metadata window doesn't
    // need to re-extract from the archive (avoids progressive decode flicker).
    let coverDataUrl = null;
    if (coverSrc) {
      try {
        coverDataUrl = await _generateCoverThumbnail(coverSrc);
      } catch (_) {}
    }
    const payload = { meta, coverSrc: coverDataUrl || coverSrc };
    // Cache for when the metadata window opens later
    try { localStorage.setItem('quivit-metadata-current', JSON.stringify(payload)); } catch (_) {}
    // Push live update to already-open metadata window
    if (window.__TAURI__) {
      window.__TAURI__.event.emit('metadata-data', payload).catch(() => {});
    }
  } else {
    // No metadata — clear localStorage and badge
    try { localStorage.removeItem('quivit-metadata-current'); } catch (_) {}
  }
}

/**
 * Loads the cover image, draws it to a small canvas, and returns a data URL.
 * Keeps the thumbnail compact (~20-40KB) so localStorage doesn't bloat.
 */
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

async function openMetadataWindow() {
  if (!_currentMeta || !window.__TAURI__) return;
  await window.__TAURI__.core.invoke('open_metadata_window').catch(console.error);
}

function updateScalingMenu() {
  document.querySelectorAll('[data-scaling]').forEach(item => {
    item.classList.toggle('checked', item.dataset.scaling === activeScaling);
  });
}

function setMenuItemMuted(id, muted) {
  const item = document.getElementById(id);
  if (!item) return;
  item.classList.toggle('muted', muted);
  item.setAttribute('aria-disabled', muted ? 'true' : 'false');
}

function updateHistoryMenu() {
  setMenuItemMuted('cmd-history-back', !NavigationHistory.canGoBack());
  setMenuItemMuted('cmd-history-forward', !NavigationHistory.canGoForward());
}



function updatePanSteps(config = Core.getState().config) {
  const fd = config?.frontend_data || {};
  keyboardPanStep = Number.isFinite(fd.keyboard_pan_step) ? fd.keyboard_pan_step : DEFAULT_KEYBOARD_PAN_STEP;
  wheelPanStep = Number.isFinite(fd.wheel_pan_step) ? fd.wheel_pan_step : DEFAULT_WHEEL_PAN_STEP;
}

function dispatchKeyboardPan(dx, dy) {
  if (dx === 0 && dy === 0) return;
  Viewer.panBy(dx * keyboardPanStep, dy * keyboardPanStep);
}

function setFileListVisible(visible) {
  Core.setFileListVisible(visible);
  document.getElementById('cmd-toggle-filelist')?.classList.toggle('checked', !!visible);
}

function pathBasename(path) {
  return String(path || '').replace(/\\/g, '/').split('/').pop() || '';
}

function showDropMessage(message, tone = 'default') {
  const textEl = dropOverlay?.querySelector('.drop-hint p');
  if (!textEl) return;
  clearTimeout(dropMessageTimer);
  textEl.textContent = message;
  dropOverlay.classList.toggle('unsupported', tone === 'error');
  if (tone === 'error') {
    dropMessageTimer = setTimeout(() => {
      textEl.textContent = DEFAULT_DROP_MESSAGE;
      dropOverlay.classList.remove('unsupported');
    }, 1800);
  }
}

function resetDropMessage() {
  showDropMessage(DEFAULT_DROP_MESSAGE);
}

async function loadDroppedPath(path) {
  if (!path) return;
  if (window.__TAURI__) {
    const kind = await window.__TAURI__.core.invoke('get_path_kind', { path }).catch(() => 'missing');
    if (kind === 'file') {
      const name = pathBasename(path);
      if (!FsUtils.isImage(name) && !FsUtils.isArchive(name)) {
        showDropMessage('File type not supported', 'error');
        return;
      }
    } else if (kind === 'missing') {
      showDropMessage('Path not found', 'error');
      return;
    }
  } else {
    const name = pathBasename(path);
    if (name.includes('.') && !FsUtils.isImage(name) && !FsUtils.isArchive(name)) {
      showDropMessage('File type not supported', 'error');
      return;
    }
  }

  FsUtils.loadFile(path, { preferInitial: true, restoreLastImage: false });
}

const actionCtx = {
  get Core() { return Core; },
  get FsUtils() { return FsUtils; },
  get Viewer() { return Viewer; },
  get NavigationHistory() { return NavigationHistory; },
  get Chrome() { return Chrome; },
  get toggleFavoriteCurrent() { return toggleFavoriteCurrent; },
  get getHighlightedFavorite() { return getHighlightedFavorite; },
  get navigateHighlightedFavorite() { return navigateHighlightedFavorite; },
  get openMetadataWindow() { return openMetadataWindow; },
  get toggleFullscreen() { return toggleFullscreen; },
  get keyboardPanStep() { return keyboardPanStep; },
  get wheelPanStep() { return wheelPanStep; }
};

function bindMenuCommands() {
  for (const action of ACTION_REGISTRY) {
    const el = document.getElementById(action.id);
    if (el) {
      el.addEventListener('click', (e) => dispatch(action.id, e, actionCtx));
    }
  }

  updateScalingMenu();
  updateHistoryMenu();
}

function bindDragDrop() {
  dropOverlay.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });

  dropOverlay.addEventListener('click', (e) => {
    e.stopPropagation();
    FsUtils.openDirectoryDialog();
  });

  if (window.__TAURI__) {
    const { listen } = window.__TAURI__.event;

    listen('tauri://drag-enter', () => {
      dropOverlay.classList.add('drag-over');
      showDropMessage('Drop to open');
    });
    listen('tauri://drag-leave', () => {
      dropOverlay.classList.remove('drag-over');
      resetDropMessage();
    });
    listen('tauri://drag-drop', (e) => {
      dropOverlay.classList.remove('drag-over');
      const paths = e.payload.paths;
      if (paths && paths.length > 0) {
        loadDroppedPath(paths[0]).catch(err => {
          console.error('[Drop] Failed to open path:', err);
          showDropMessage('Unable to open file', 'error');
        });
      }
    });
    // Active theme/CSS previews are kept across config reloads so they are not
    // wiped by config-changed (the file watcher fires whenever the main window
    // persists state, e.g. last_active_image). Cleared on Options Apply.
    let previewTheme = null;
    let previewCss = null;



    listen('config-updated', () => {
      previewTheme = null;
      previewCss = null;
      resetScrollLatch();
      Core.loadConfig();
    });
    // File watcher detected the config file changed on disk (another instance,
    // or the main window's own state persistence) — reload to stay in sync but
    // keep an in-progress theme/CSS preview intact.
    listen('config-changed', () => {
      resetScrollLatch();
      Core.loadConfig();
    });
    // Re-apply the persisted scroll-wheel latch once config has (re)loaded —
    // startup and after Options Apply. resetScrollLatch() above clears
    // it in-memory first, then this restores the saved toggle state.
    window.addEventListener('quivit-config-loaded', () => {
      const config = Core.getState().config;
      updatePanSteps(config);
      syncKeyLabel();
      syncScrollLatch(config);

      if (window.__TAURI__) {
        window.__TAURI__.window.getCurrentWindow().isFullscreen().then(syncFullscreenState).catch(console.error);
      } else {
        syncFullscreenState(!!document.fullscreenElement);
      }
      const theme = config?.frontend_data?.theme || 'system';
      const customCss = config?.frontend_data?.custom_css || '';

      try {
        if (theme === 'light' || theme === 'dark') localStorage.setItem('quivit-theme', theme);
        else localStorage.removeItem('quivit-theme');
        if (customCss) localStorage.setItem('quivit-custom-css', customCss);
        else localStorage.removeItem('quivit-custom-css');
      } catch (e) {}

      if (previewTheme !== null) {
        applyTheme(previewTheme);
      } else {
        applyTheme(theme);
      }

      if (previewCss !== null) {
        applyCustomCss(previewCss);
      } else {
        applyCustomCss(customCss);
      }
    });
    listen('single-instance-open', (e) => {
      if (e.payload) {
        FsUtils.loadFile(e.payload, { preferInitial: true, restoreLastImage: false }).catch(console.error);
      }
    });
    listen('theme-preview', (e) => {
      previewTheme = e.payload;
      applyTheme(previewTheme);
    });
    listen('css-preview', (e) => {
      previewCss = e.payload;
      applyCustomCss(previewCss);
    });
    return;
  }

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropOverlay.classList.add('drag-over');
    showDropMessage('Drop to open');
  });

  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) {
      dropOverlay.classList.remove('drag-over');
      resetDropMessage();
    }
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dropOverlay.classList.remove('drag-over');

    const file = e.dataTransfer.getData('text/plain');
    if (file) {
      loadDroppedPath(file).catch(err => {
        console.error('[Drop] Failed to open path:', err);
        showDropMessage('Unable to open file', 'error');
      });
    }
  });
}

// --- Window title ----------------------------------------------------------
// Title reflects the currently displayed image: `filename.ext (current/total)
// ◦ container ◦ QuiviT`. Only images get a title; nothing/folder/.. /archive
// selections fall back to "QuiviT". Page count is image-only, natural ascending
// order, independent of the active sort. setTitle only fires on actual change.
let _lastTitle = '';
function updateWindowTitle(state) {
  if (!window.__TAURI__) return;
  const win = window.__TAURI__.window?.getCurrentWindow?.();
  if (!win?.setTitle) return;

  let title = 'QuiviT';
  if (state.mode !== 'empty' && state.src) {
    const pos = FsUtils.naturalPagePosition(state.list, state.filename);
    const page = pos && pos.total > 1 ? ` (${pos.current}/${pos.total})` : '';
    if (state.mode === 'archive' && state.archivePath) {
      const name = FsUtils.basename(state.archivePath);
      if (name) title = `${state.filename}${page} ◦ ${name} ◦ QuiviT`;
    } else {
      title = `${state.filename}${page} ◦ QuiviT`;
    }
  }

  if (title !== _lastTitle) {
    _lastTitle = title;
    win.setTitle(title).catch(() => {});
  }
}


Core.onStateChange((state) => {
  updateWindowTitle(state);

  if (!_uiInitialized && state.config?.frontend_data) {
    const fd = state.config.frontend_data;
    if (fd.menu_visible !== undefined) {
      Chrome.setMenuBarVisible(fd.menu_visible);
    }
    if (fd.status_visible !== undefined) {
      Chrome.setStatusBarVisible(fd.status_visible);
    }
    
    // Explicitly sync checkmarks that rely on state on startup
    document.getElementById('cmd-toggle-filelist')?.classList.toggle('checked', !!state.fileListVisible);
    document.getElementById('cmd-fullscreen')?.classList.toggle('checked', isFullscreenActive());
    
    _uiInitialized = true;
  }

  updateMenuShortcuts(state.config);

  if (state.mode === 'empty') {
    dropOverlay.classList.add('active');
    viewport.classList.add('empty');
    statusbar.classList.add('hidden');
    return;
  }

  if (!state.src) {
    dropOverlay.classList.add('active');
    viewport.classList.add('empty');
  } else {
    dropOverlay.classList.remove('active');
    viewport.classList.remove('empty');
  }

  // Apply statusbar visibility
  Chrome.applyStatusBarVisibility();

  if (state.config && state.config.frontend_data) {
    const isTransparent = !!state.config.frontend_data.transparent_bg;
    const grillEl = document.getElementById('img-grill');
    const grillBorderEl = document.getElementById('img-grill-border');
    const toggleEl = document.getElementById('cmd-toggle-transparent');
    
    if (grillEl) grillEl.classList.toggle('active', !isTransparent);
    if (grillBorderEl) grillBorderEl.classList.toggle('active', !isTransparent);
    if (toggleEl) {
      toggleEl.classList.toggle('checked', !isTransparent);
    }
  }

  // Auto-update standard statusbar fields (fit mode, index, empty state)
  Statusbar.update(state);

  if (state.scalingMode !== activeScaling) {
    activeScaling = state.scalingMode;
    Viewer.setScaling(activeScaling);
    updateScalingMenu();
  }

  updateHistoryMenu();




  // Auto-fetch ComicInfo metadata when entering a new archive.
  if (state.mode === 'archive' && state.archivePath) {
    _loadMetadataForArchive(state.archivePath, state.archiveMetadataFiles || [], state.list).catch(console.error);
  } else if (state.mode !== 'archive') {
    // Left the archive — clear badge
    _lastMetadataArchive = null;
    _currentMeta = null;
    metadataBadge.classList.add('hidden');
    try { localStorage.removeItem('quivit-metadata-current'); } catch (_) {}
  }
});

window.addEventListener('quivit-history-changed', () => {
  updateHistoryMenu();
});



// Badge opens the metadata window
metadataBadge.addEventListener('click', () => openMetadataWindow());
metadataBadge.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMetadataWindow(); } });

Statusbar.init();
initFullscreen();
initFilePanel({ filePanel, breadcrumbEl: filePanelBreadcrumb, fileListUl, resizeHandle, Core, FsUtils });
initMenuBar();
bindMenuCommands();
bindDragDrop();
bindKeyboardShortcuts({ Core, dispatchAction: (id, payload) => dispatch(id, payload, actionCtx), dispatchKeyboardPan });

if (window.__TAURI__) {
  let watchTimer = null;
  window.__TAURI__.event.listen('directory-changed', () => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      FsUtils.refresh();
    }, 500);
  }).catch(console.error);

  const mainWindow = window.__TAURI__.window.getCurrentWindow();
  let closingAfterFlush = false;
  mainWindow.onCloseRequested(async (event) => {
    if (closingAfterFlush) return;
    event.preventDefault();
    try {
      await Core.flushConfig();
    } catch (err) {
      console.error('[Main] Failed to flush config on exit:', err);
    }
    closingAfterFlush = true;
    await mainWindow.close();
  });
}

Core.init();