/**
 * main.js - main window DOM wiring.
 */

import { Core } from './core.js';
import { FsUtils } from './fsUtils.js';
import { Viewer } from './viewer.js';
import * as NavigationHistory from './navigationHistory.js';
import { initFilePanel, renderFilePanel, toggleFavoriteCurrent, getHighlightedFavorite, navigateHighlightedFavorite } from './filePanel.js';
import { VIEWER_KEYBOARD_PAN_STEP, VIEWER_WHEEL_PAN_STEP } from './keybinds.js';
import { bindKeyboardShortcuts, updateMenuShortcuts, resetScrollLatch, syncScrollLatch } from './shortcuts.js';
import {
  initMenuBar,
  closeMenus,
  toggleMenuBar,
  menuBarVisible,
  setMenuBarVisible,
  getPreFullscreenState,
  setPreFullscreenState,
  saveUIState
} from './menubar.js';
import { fetchMetadata, findMetadataEntry } from './metadata.js';

// Reset the options tab state on app startup so it defaults to General per session
localStorage.removeItem('options-active-tab');

// Emergency CSS Reset (Ctrl+Shift+Alt+C)
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.altKey && e.key.toLowerCase() === 'c') {
    e.preventDefault();
    localStorage.removeItem('quivit-custom-css');
    if (window.__TAURI__) {
      window.__TAURI__.event.emit('css-preview', '');
    }
    const state = Core.getState();
    if (state.config && state.config.frontend_data) {
      state.config.frontend_data.custom_css = "";
      if (window.__TAURI__) {
        window.__TAURI__.core.invoke('save_config', { config: state.config })
          .then(() => {
            window.__TAURI__.event.emit('config-updated');
            window.location.reload();
          })
          .catch(err => {
            console.error('Failed emergency reset save:', err);
            window.location.reload();
          });
      }
    } else {
      window.location.reload();
    }
  }

  // Global Tab Navigation Jump (Home/End)
  if (!['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && (e.key === 'Home' || e.key === 'End')) {
    const tabbables = Array.from(document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter(el => el.offsetWidth > 0 && el.offsetHeight > 0 && window.getComputedStyle(el).visibility !== 'hidden');
    if (tabbables.length > 0) {
      if (e.key === 'Home') {
        e.preventDefault();
        tabbables[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        tabbables[tabbables.length - 1].focus();
      }
    }
  }
});

const dropOverlay = document.getElementById('drop-overlay');
const menubar = document.getElementById('menubar');
const viewport = document.getElementById('viewport');
const statusbar = document.getElementById('statusbar');
const statusName = document.querySelector('.status-filename');
const statusDims = document.querySelector('.status-dims');
const statusIndex = document.querySelector('.status-index');
const statusZoom = document.querySelector('.status-zoom');
const statusFit = document.querySelector('.status-fit');

const filePanel = document.getElementById('file-panel');
const filePanelBreadcrumb = document.getElementById('file-panel-breadcrumb');
const fileListUl = document.getElementById('file-list');
const resizeHandle = document.getElementById('panel-resize-handle');
const metadataBadge = document.getElementById('status-metadata-badge');

let activeScaling = '';
let statusBarVisible = true; // updated from config when loaded
let _uiInitialized = false;
let fullscreenActive = false;
let dropMessageTimer = null;
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

function updateViewToggleMenu(state = Core.getState()) {
  document.getElementById('cmd-toggle-filelist')?.classList.toggle('checked', !!state.fileListVisible);
  document.getElementById('cmd-toggle-menubar')?.classList.toggle('checked', menuBarVisible);
  document.getElementById('cmd-toggle-statusbar')?.classList.toggle('checked', statusBarVisible);
  document.getElementById('cmd-fullscreen')?.classList.toggle('checked', fullscreenActive);
}

function setScaling(mode) {
  Core.setScalingMode(mode, { persist: true });
}

function applyCustomCss(cssText) {
  let styleEl = document.getElementById('custom-css');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'custom-css';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = cssText || '';
}

async function toggleFullscreen() {
  const enteringFullscreen = window.__TAURI__
    ? !(await window.__TAURI__.window.getCurrentWindow().isFullscreen())
    : !document.fullscreenElement;

  const config = Core.getState()?.config;
  const hideChrome = config?.frontend_data?.hide_chrome_on_fullscreen !== false;

  if (enteringFullscreen) {
    // Snapshot current visibility before hiding
    setPreFullscreenState({ menuBar: menuBarVisible, statusBar: statusBarVisible });
    if (hideChrome) {
      if (menuBarVisible) toggleMenuBar();
      if (statusBarVisible) toggleStatusBar();
    }
  } else {
    // Restore from snapshot if we have one
    const pre = getPreFullscreenState();
    if (pre) {
      if (menuBarVisible !== pre.menuBar) toggleMenuBar();
      if (statusBarVisible !== pre.statusBar) toggleStatusBar();
      setPreFullscreenState(null);
    }
  }

  if (window.__TAURI__) {
    const win = window.__TAURI__.window.getCurrentWindow();
    win.setFullscreen(enteringFullscreen);
  } else if (enteringFullscreen) {
    document.documentElement.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
  fullscreenActive = enteringFullscreen;
  updateViewToggleMenu();
}

function toggleStatusBar() {
  statusBarVisible = !statusBarVisible;
  // If we're in empty mode, it stays hidden regardless of the toggle,
  // but we still persist the toggle state.
  if (Core.getState().mode !== 'empty') {
    statusbar.classList.toggle('hidden', !statusBarVisible);
  }
  const state = Core.getState();
  if (state.config && state.config.frontend_data) {
    state.config.frontend_data.status_visible = statusBarVisible;
    if (window.__TAURI__) {
      window.__TAURI__.core.invoke('save_config', { config: state.config }).catch(console.error);
    }
  }
}

async function openGithub() {
  const url = 'https://github.com/4163/quivi-t';
  if (window.__TAURI__?.opener?.openUrl) {
    await window.__TAURI__.opener.openUrl(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
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

function dispatchAction(actionId, payload) {
  // Try to find the button just to provide visual feedback if needed, but don't rely on it for execution
  const btn = document.getElementById(actionId);
  if (btn && btn.classList.contains('menu-trigger')) {
     // If it's a top level menu we could toggle it, but for actions we just execute them below
  }

  const wheelStep = payload?.wheel ? VIEWER_WHEEL_PAN_STEP : VIEWER_KEYBOARD_PAN_STEP;

  switch (actionId) {
    case 'cmd-open-dir':
      FsUtils.openDirectoryDialog();
      break;
    case 'cmd-open-file':
      FsUtils.openFileDialog();
      break;
    case 'cmd-refresh':
      FsUtils.refresh();
      break;
    case 'cmd-history-back': {
      const entry = NavigationHistory.goBack(Core.getState());
      if (entry) FsUtils.loadHistoryEntry(entry).catch(console.error);
      break;
    }
    case 'cmd-history-forward': {
      const entry = NavigationHistory.goForward(Core.getState());
      if (entry) FsUtils.loadHistoryEntry(entry).catch(console.error);
      break;
    }
    case 'cmd-toggle-favorite':
      toggleFavoriteCurrent();
      break;
    case 'cmd-fullscreen':
      toggleFullscreen();
      break;
    case 'cmd-parent':
      FsUtils.openParent();
      break;
    case 'cmd-next':
      if (document.activeElement?.closest('#favorites-list')) navigateHighlightedFavorite(1);
      else Core.navigate(1);
      break;
    case 'cmd-prev':
      if (document.activeElement?.closest('#favorites-list')) navigateHighlightedFavorite(-1);
      else Core.navigate(-1);
      break;
    case 'cmd-zoom-in':
      if (payload?.wheel) Viewer.zoomAt(1, payload.clientX, payload.clientY);
      else Viewer.zoomCenter(1);
      break;
    case 'cmd-zoom-out':
      if (payload?.wheel) Viewer.zoomAt(-1, payload.clientX, payload.clientY);
      else Viewer.zoomCenter(-1);
      break;
    case 'cmd-zoom-100':
      Viewer.setZoom(1);
      break;
    case 'cmd-fit-none':
      Core.setFitMode('none', { persist: true });
      Viewer.applyFitMode();
      break;
    case 'cmd-fit-width':
      Core.setFitMode('width', { persist: true });
      Viewer.applyFitMode();
      break;
    case 'cmd-fit-height':
      Core.setFitMode('height', { persist: true });
      Viewer.applyFitMode();
      break;
    case 'cmd-fit-width-if-larger':
      Core.setFitMode('width-if-larger', { persist: true });
      Viewer.applyFitMode();
      break;
    case 'cmd-fit-height-if-larger':
      Core.setFitMode('height-if-larger', { persist: true });
      Viewer.applyFitMode();
      break;
    case 'cmd-fit-best':
      Core.setFitMode('window', { persist: true });
      Viewer.applyFitMode();
      break;
    case 'cmd-scale-none':
      setScaling('none');
      break;
    case 'cmd-scale-bicubic':
      setScaling('bicubic');
      break;
    case 'cmd-scale-lanczos':
      setScaling('lanczos');
      break;
    case 'cmd-rotate-ccw':
      Viewer.rotate(-90);
      break;
    case 'cmd-rotate-cw':
      Viewer.rotate(90);
      break;
    case 'cmd-flip-horizontal':
      Viewer.flipHorizontal();
      break;
    case 'cmd-flip-vertical':
      Viewer.flipVertical();
      break;
    case 'cmd-open-next-container':
      FsUtils.openSibling(1);
      break;
    case 'cmd-open-prev-container':
      FsUtils.openSibling(-1);
      break;
    case 'cmd-pan-up':
      Viewer.panBy(0, wheelStep);
      break;
    case 'cmd-pan-left':
      Viewer.panBy(wheelStep, 0);
      break;
    case 'cmd-pan-down':
      Viewer.panBy(0, -wheelStep);
      break;
    case 'cmd-pan-right':
      Viewer.panBy(-wheelStep, 0);
      break;
    case 'cmd-toggle-menubar':
      toggleMenuBar();
      updateViewToggleMenu();
      break;
    case 'cmd-toggle-filelist':
      Core.toggleFileList();
      break;
    case 'cmd-toggle-transparent':
      Core.toggleTransparentBg();
      break;
    case 'cmd-toggle-statusbar':
      toggleStatusBar();
      updateViewToggleMenu();
      break;
    case 'cmd-options':
      if (window.__TAURI__) window.__TAURI__.core.invoke('open_options').catch(console.error);
      break;
    case 'cmd-quit':
      if (window.__TAURI__) window.__TAURI__.core.invoke('plugin:process|exit');
      else window.close();
      break;
    case 'cmd-cycle-scaling':
    case 'cmd-cycle-scaling-back': {
      const modes = ['none', 'bicubic', 'lanczos'];
      const current = Core.getState().scalingMode;
      const delta = actionId === 'cmd-cycle-scaling-back' ? -1 : 1;
      const next = modes[(modes.indexOf(current) + delta + modes.length) % modes.length];
      setScaling(next);
      break;
    }
    default:
      break;
  }
}

function bindMenuCommands() {
  document.getElementById('cmd-open-dir').addEventListener('click', () => FsUtils.openDirectoryDialog());
  document.getElementById('cmd-open-file').addEventListener('click', () => FsUtils.openFileDialog());
  document.getElementById('cmd-refresh').addEventListener('click', () => FsUtils.refresh());
  document.getElementById('cmd-history-back').addEventListener('click', () => dispatchAction('cmd-history-back'));
  document.getElementById('cmd-history-forward').addEventListener('click', () => dispatchAction('cmd-history-forward'));
  document.getElementById('cmd-fullscreen').addEventListener('click', () => toggleFullscreen());
  document.getElementById('cmd-parent').addEventListener('click', () => FsUtils.openParent());
  document.getElementById('cmd-next').addEventListener('click', () => Core.navigate(1));
  document.getElementById('cmd-prev').addEventListener('click', () => Core.navigate(-1));
  document.getElementById('cmd-open-next-container').addEventListener('click', () => FsUtils.openSibling(1));
  document.getElementById('cmd-open-prev-container').addEventListener('click', () => FsUtils.openSibling(-1));
  document.getElementById('cmd-zoom-in').addEventListener('click', () => Viewer.zoomCenter(1));
  document.getElementById('cmd-zoom-out').addEventListener('click', () => Viewer.zoomCenter(-1));
  document.getElementById('cmd-zoom-100').addEventListener('click', () => Viewer.setZoom(1));
  document.getElementById('cmd-fit-none').addEventListener('click', () => Core.setFitMode('none', { persist: true }));
  document.getElementById('cmd-fit-width').addEventListener('click', () => Core.setFitMode('width', { persist: true }));
  document.getElementById('cmd-fit-height').addEventListener('click', () => Core.setFitMode('height', { persist: true }));
  document.getElementById('cmd-fit-width-if-larger').addEventListener('click', () => Core.setFitMode('width-if-larger', { persist: true }));
  document.getElementById('cmd-fit-height-if-larger').addEventListener('click', () => Core.setFitMode('height-if-larger', { persist: true }));
  document.getElementById('cmd-fit-best').addEventListener('click', () => Core.setFitMode('window', { persist: true }));
  document.getElementById('cmd-scale-none').addEventListener('click', () => setScaling('none'));
  document.getElementById('cmd-scale-bicubic').addEventListener('click', () => setScaling('bicubic'));
  document.getElementById('cmd-scale-lanczos').addEventListener('click', () => setScaling('lanczos'));
  document.getElementById('cmd-rotate-cw').addEventListener('click', () => Viewer.rotate(90));
  document.getElementById('cmd-rotate-ccw').addEventListener('click', () => Viewer.rotate(-90));
  document.getElementById('cmd-flip-horizontal').addEventListener('click', () => Viewer.flipHorizontal());
  document.getElementById('cmd-flip-vertical').addEventListener('click', () => Viewer.flipVertical());
  document.getElementById('cmd-toggle-transparent').addEventListener('click', () => Core.toggleTransparentBg());
  document.getElementById('cmd-toggle-menubar').addEventListener('click', () => dispatchAction('cmd-toggle-menubar'));
  document.getElementById('cmd-toggle-filelist').addEventListener('click', () => Core.toggleFileList());
  document.getElementById('cmd-toggle-statusbar').addEventListener('click', () => dispatchAction('cmd-toggle-statusbar'));
  document.getElementById('cmd-github').addEventListener('click', () => {
    openGithub().catch(err => console.error('[GitHub] Failed to open repository:', err));
  });

  document.getElementById('cmd-options').addEventListener('click', async () => {
    if (!window.__TAURI__) return;
    try {
      await window.__TAURI__.core.invoke('open_options');
    } catch (err) {
      console.error('[Options] Failed to open options window:', err);
    }
  });

  document.getElementById('cmd-quit').addEventListener('click', () => {
    if (window.__TAURI__) window.__TAURI__.core.invoke('plugin:process|exit');
    else window.close();
  });

  // --- File panel action buttons ---
  // Favorites for images inside archives store composite "archive|entry" paths.
  // These helpers resolve the real archive path / its containing folder so the
  // OS-explorer actions work.
  function archiveEntryRealPath(favPath) {
    const sep = favPath.indexOf('|');
    return sep === -1 ? favPath : favPath.slice(0, sep);
  }
  function archiveEntryContainerPath(favPath) {
    return archiveEntryRealPath(favPath).replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');
  }

  const btnOpenExplorer = document.getElementById('cmd-open-explorer');
  if (btnOpenExplorer) {
    btnOpenExplorer.addEventListener('click', async () => {
      const state = Core.getState();
      if (!window.__TAURI__) return;
      const favorite = getHighlightedFavorite();
      if (favorite) {
        try {
          if (favorite.is_drive) {
            await window.__TAURI__.core.invoke('open_in_explorer', { path: favorite.path });
          } else {
            await window.__TAURI__.opener.revealItemInDir(favorite.path.includes('|') ? archiveEntryRealPath(favorite.path) : favorite.path);
          }
        } catch (err) {
          console.error('[Action] Failed to open explorer:', err);
        }
        return;
      }
      const entry = state.list[state.index];
      if (!entry) return;
      try {
        if (entry.is_parent) {
          await window.__TAURI__.core.invoke('open_in_explorer', { path: state.directory });
        } else if (entry.path.includes('|')) {
          await window.__TAURI__.opener.revealItemInDir(archiveEntryRealPath(entry.path));
        } else {
          await window.__TAURI__.opener.revealItemInDir(entry.path);
        }
      } catch (err) {
        console.error('[Action] Failed to open explorer:', err);
      }
    });
  }

  const btnOpenFolder = document.getElementById('cmd-open-folder');
  if (btnOpenFolder) {
    btnOpenFolder.addEventListener('click', async () => {
      const state = Core.getState();
      if (!window.__TAURI__) return;
      const favorite = getHighlightedFavorite();
      if (favorite) {
        try {
          let targetPath;
          if (favorite.is_dir || favorite.is_drive) {
            targetPath = favorite.path;
          } else if (favorite.path.includes('|')) {
            targetPath = archiveEntryContainerPath(favorite.path);
          } else {
            targetPath = favorite.path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');
          }
          await window.__TAURI__.core.invoke('open_in_explorer', { path: targetPath });
        } catch (err) {
          console.error('[Action] Failed to open folder:', err);
        }
        return;
      }
      const entry = state.list[state.index];
      let targetPath = state.directory;

      if (entry) {
        if (entry.is_dir || entry.is_parent) {
          targetPath = entry.path;
        } else if (entry.path.includes('|')) {
          targetPath = archiveEntryContainerPath(entry.path);
        }
      }
      try {
        await window.__TAURI__.core.invoke('open_in_explorer', { path: targetPath });
      } catch (err) {
        console.error('[Action] Failed to open folder:', err);
      }
    });
  }

  updateScalingMenu();
  updateHistoryMenu();
  updateViewToggleMenu();
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

    function applyPreviewTheme(theme) {
      document.documentElement.removeAttribute('data-theme');
      if (theme === 'light' || theme === 'dark') {
        document.documentElement.setAttribute('data-theme', theme);
      }
    }

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
      syncScrollLatch(config);
      if (previewTheme !== null) {
        applyPreviewTheme(previewTheme);
      }
      if (previewCss !== null) {
        applyCustomCss(previewCss);
      } else {
        applyCustomCss(config?.frontend_data?.custom_css || '');
      }
    });
    listen('single-instance-open', (e) => {
      if (e.payload) {
        FsUtils.loadFile(e.payload, { preferInitial: true, restoreLastImage: false }).catch(console.error);
      }
    });
    listen('theme-preview', (e) => {
      previewTheme = e.payload;
      applyPreviewTheme(previewTheme);
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

Core.onStateChange((state) => {
  if (!_uiInitialized && state.config?.frontend_data) {
    const fd = state.config.frontend_data;
    if (fd.menu_visible !== undefined) {
      setMenuBarVisible(fd.menu_visible);
    }
    if (fd.status_visible !== undefined) {
      statusBarVisible = fd.status_visible;
    }
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

  // Show statusbar only if the user hasn't hidden it
  if (statusBarVisible) statusbar.classList.remove('hidden');
  else statusbar.classList.add('hidden');

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

  // Only update filename/index if the image is already loaded;
  // otherwise viewer.js is showing "Loading..." and we don't want to overwrite it.
  const imgEl2 = document.getElementById('viewer-img');
  if (!state.src || imgEl2.src === state.src) {
    statusName.textContent = state.filename;
    statusIndex.textContent = state.list.length > 1 ? `${state.index + 1} / ${state.list.length}` : '';
  }

  // Items that aren't images (folders, archives, `..`, drives) have no
  // dimensions or zoom level; show N/A instead of stale image metrics.
  const currentEntry = state.list[state.index];
  const isImage = !!currentEntry && FsUtils.isImageEntry(currentEntry) && state.src;
  if (!isImage) {
    statusDims.textContent = 'N/A';
    statusZoom.textContent = 'N/A';
  }

  const fitDisplay = state.fitMode.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  statusFit.textContent = `Fit: ${fitDisplay}`;

  if (state.scalingMode !== activeScaling) {
    activeScaling = state.scalingMode;
    Viewer.setScaling(activeScaling);
    updateScalingMenu();
  }

  updateHistoryMenu();
  updateViewToggleMenu(state);

  renderFilePanel(state);

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

initFilePanel({ filePanel, breadcrumbEl: filePanelBreadcrumb, fileListUl, resizeHandle, Core, Viewer, FsUtils });
initMenuBar();
bindMenuCommands();
bindDragDrop();
bindKeyboardShortcuts({ Core, dispatchAction });

if (window.__TAURI__) {
  let watchTimer = null;
  window.__TAURI__.event.listen('directory-changed', () => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      FsUtils.refresh();
    }, 500);
  }).catch(console.error);
}

Core.init();
