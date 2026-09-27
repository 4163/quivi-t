/**
 * main/main.js: main window DOM wiring bootstrap.
 */

import { Core } from '../core.js';
import { FsUtils } from '../fsUtils.js';
import { Viewer } from '../viewer/viewer.js';
import * as NavigationHistory from '../navigationHistory.js';
import {
  initFilePanel,
  toggleFavoriteCurrent,
  getHighlightedFavorite,
  navigateHighlightedFavorite,
  getHighlightedLibrary,
  navigateHighlightedLibrary,
  focusFileList,
  isFileListFocused,
  getFileListViewportRange,
  clearLibraryPathCaches
} from '../filepanel/filePanel.js';
import { bindKeyboardShortcuts, updateMenuShortcuts, resetScrollLatch, syncScrollLatch } from '../shortcuts.js';
import { applyTheme, applyCustomCss } from '../shared/theme.js';
import { DEFAULT_KEYBOARD_PAN_STEP, DEFAULT_WHEEL_PAN_STEP } from '../keybinds.js';
import { Statusbar } from '../menubar/statusbar.js';
import { initMenuBar, syncViewMenu } from '../menubar.js';
import * as Chrome from '../menubar/chrome.js';
import { initFullscreen, toggleFullscreen, syncFullscreenState, isFullscreenActive, syncKeyLabel } from './fullscreen.js';

import { handleTabJump } from '../keyboardNav.js';
import { emergencyCssReset } from '../shared/configPreview.js';
import { ACTION_REGISTRY, dispatch } from '../services/actions.js';

import { initLifecycle } from './lifecycle.js';
import { initMetadataBadge, openMetadataWindow } from './metadataBadge.js';
import { initDropZone } from './dropzone.js';
import { initPasswordOverlay } from './passwordOverlay.js';
import { initUrlOverlay } from './urlOverlay.js';
import { UrlLoader } from '../urlLoader.js';
import { initViewerAudio, ViewerAudio } from '../viewer/viewerAudio.js';
import {
  initManhwaStrip,
  isManhwaStripActive,
  centerListItem,
  getFirstImageIndex,
  getLastImageIndex,
  navigateManhwa,
  pageStrip,
} from '../viewer/manhwaStrip.js';

// Reset the options tab on startup so each session starts on General.
localStorage.removeItem('options-active-tab');

// Emergency CSS reset (Ctrl+Shift+Alt+C).
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.altKey && e.key.toLowerCase() === 'c') {
    e.preventDefault();
    emergencyCssReset(Core.getState().config);
  }

  // Home/End jumps across tabbable controls.
  handleTabJump(e);
});

// Manhwa strip owns Home/End/PageUp/PageDown at any focus (except text
// inputs) so panel legacy keys never divert them to '..' or row jumps.
// Capture phase plus stopPropagation preempts the file-list handler.
window.addEventListener('keydown', (e) => {
  if (!isManhwaStripActive()) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.ctrlKey || e.altKey) return;

  let handled = false;
  if (e.key === 'Home') {
    const firstIdx = getFirstImageIndex();
    if (firstIdx !== -1) {
      Core.selectIndex(firstIdx);
      handled = centerListItem(firstIdx);
    }
  } else if (e.key === 'End') {
    const lastIdx = getLastImageIndex();
    if (lastIdx !== -1) {
      Core.selectIndex(lastIdx);
      handled = centerListItem(lastIdx);
    }
  } else if (e.key === 'PageUp') {
    handled = pageStrip(-1);
  } else if (e.key === 'PageDown') {
    handled = pageStrip(1);
  }

  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

const dropOverlay = document.getElementById('drop-overlay');
const passwordOverlay = document.getElementById('password-overlay');
const urlOverlayEl = document.getElementById('url-overlay');
const viewport = document.getElementById('viewport');
const statusbar = document.getElementById('statusbar');
const filePanel = document.getElementById('file-panel');
const filePanelBreadcrumb = document.getElementById('file-panel-breadcrumb');
const fileListUl = document.getElementById('file-list');
const resizeHandle = document.getElementById('panel-resize-handle');
const metadataBadgeEl = document.getElementById('status-metadata-badge');

let _uiInitialized = false;
let keyboardPanStep = DEFAULT_KEYBOARD_PAN_STEP;
let wheelPanStep = DEFAULT_WHEEL_PAN_STEP;

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

const actionCtx = {
  get Core() { return Core; },
  get FsUtils() { return FsUtils; },
  get Viewer() { return Viewer; },
  get NavigationHistory() { return NavigationHistory; },
  get Chrome() { return Chrome; },
  get toggleFavoriteCurrent() { return toggleFavoriteCurrent; },
  get getHighlightedFavorite() { return getHighlightedFavorite; },
  get navigateHighlightedFavorite() { return navigateHighlightedFavorite; },
  get getHighlightedLibrary() { return getHighlightedLibrary; },
  get navigateHighlightedLibrary() { return navigateHighlightedLibrary; },
  get openMetadataWindow() { return openMetadataWindow; },
  get toggleFullscreen() { return toggleFullscreen; },
  get UrlLoader() { return UrlLoader; },
  get ViewerAudio() { return ViewerAudio; },
  isFavoritesFocused: () => !!document.activeElement?.closest('#favorites-list'),
  isLibraryFocused: () => !!document.activeElement?.closest('#file-panel-library, .library-provider-list'),
  get keyboardPanStep() { return keyboardPanStep; },
  get wheelPanStep() { return wheelPanStep; },
  get centerListItem() { return centerListItem; },
  get navigateManhwa() { return navigateManhwa; }
};

function bindMenuCommands() {
  for (const action of ACTION_REGISTRY) {
    const el = document.getElementById(action.id);
    if (el) {
      el.addEventListener('click', (e) => {
        if (el.classList.contains('muted') || el.getAttribute('aria-disabled') === 'true') return;
        dispatch(action.id, e, actionCtx);
      });
    }
  }

  syncViewMenu(Core.getState());
  updateHistoryMenu();
}

Core.onStateChange((state) => {
  if (!_uiInitialized && state.config?.frontend_data) {
    const fd = state.config.frontend_data;
    if (fd.menu_visible !== undefined) {
      Chrome.setMenuBarVisible(fd.menu_visible);
    }
    if (fd.status_visible !== undefined) {
      Chrome.setStatusBarVisible(fd.status_visible);
    }
    
    // Sync checkmarks that rely on startup state.
    document.getElementById('cmd-toggle-filelist')?.classList.toggle('checked', !!state.fileListVisible);
    document.getElementById('cmd-fullscreen')?.classList.toggle('checked', isFullscreenActive());
    
    _uiInitialized = true;
  }

  updateMenuShortcuts(state.config);

  const isPasswordBlocked = state.archiveEncryption === 'password_required' || state.archiveEncryption === 'password_incorrect';

  if (state.mode === 'empty' && !isPasswordBlocked) {
    dropOverlay.classList.add('active');
    viewport.classList.add('empty');
    statusbar.classList.add('hidden');
    document.getElementById('img-grill')?.classList.remove('active');
    document.getElementById('img-grill-border')?.classList.remove('active');
    document.getElementById('manhwa-strip')?.classList.remove('grill-active');
    return;
  }

  if (!state.src) {
    dropOverlay.classList.toggle('active', !isPasswordBlocked);
    viewport.classList.add('empty');
  } else {
    dropOverlay.classList.remove('active');
    viewport.classList.remove('empty');
  }

  // Apply statusbar visibility.
  Chrome.applyStatusBarVisibility();

  if (state.config && state.config.frontend_data) {
    const isTransparent = !!state.config.frontend_data.transparent_bg;
    const grillEl = document.getElementById('img-grill');
    const grillBorderEl = document.getElementById('img-grill-border');
    const stripEl = document.getElementById('manhwa-strip');
    const toggleEl = document.getElementById('cmd-toggle-transparent');
    
    const showSingleGrill = !isTransparent && !!state.src;
    if (grillEl) grillEl.classList.toggle('active', showSingleGrill);
    if (grillBorderEl) grillBorderEl.classList.toggle('active', showSingleGrill);
    if (stripEl) stripEl.classList.toggle('grill-active', !isTransparent && isManhwaStripActive() && (state.list?.length || 0) > 0);
    if (toggleEl) {
      toggleEl.classList.toggle('checked', !isTransparent);
    }
  }

  // Update standard statusbar fields.
  Statusbar.update(state);

  syncViewMenu(state);
  updateHistoryMenu();
});

window.addEventListener('quivit-history-changed', () => {
  updateHistoryMenu();
});

// Initialization.
Statusbar.init();
initFullscreen();
initFilePanel({ filePanel, breadcrumbEl: filePanelBreadcrumb, fileListUl, resizeHandle, Core, FsUtils });
initManhwaStrip();
initMenuBar();
bindMenuCommands();
initDropZone({ dropOverlay, FsUtils });
initPasswordOverlay({ overlay: passwordOverlay, Core, FsUtils, focusFileList, isFileListFocused });
const urlOverlay = initUrlOverlay({
  overlay: urlOverlayEl,
  filePanel,
  Core,
  focusFileList,
  onSubmit: async (url) => {
    const { galleryPath, targetName } = await UrlLoader.loadUrl(url);
    await FsUtils.loadFile(galleryPath, targetName ? { targetName } : {});
  }
});
UrlLoader.init({ Core, FsUtils, urlOverlay, getFileListViewportRange });
initMetadataBadge({ Core, FsUtils, badgeEl: metadataBadgeEl });
initViewerAudio({ Core, FsUtils });
initLifecycle({ Core, FsUtils, UrlLoader });

let previewTheme = null;
let previewCss = null;

async function reloadConfigAndSyncLibrary(relocation = null) {
  const cachedLibraryPath = relocation?.oldPath || UrlLoader.getCachedLibraryDir();
  // Flush dirty prefs first so a watcher-triggered reload never wipes an
  // unsaved change inside the debounce window (lost-update).
  await Core.flushConfig().catch(() => {});
  await Core.loadConfig();
  // Another QuiviT process receives the config watcher event but not the
  // in-process relocation event, so it must replace its old root watcher too.
  await window.__TAURI__.core.invoke('rebind_library_watcher').catch(err => {
    console.warn('[Main] Failed to rebind the Library watcher:', err);
  });
  const libraryPath = relocation?.libraryPath || await UrlLoader.reloadLibraryDir();
  const change = UrlLoader.handleLibraryRelocation({
    oldPath: cachedLibraryPath,
    libraryPath
  });
  if (change.changed) {
    NavigationHistory.remapLibraryPaths(change.oldPath, change.libraryPath);
    clearLibraryPathCaches();
  }
}

bindKeyboardShortcuts({ Core, dispatchAction: (id, payload) => dispatch(id, payload, actionCtx), dispatchKeyboardPan });

if (window.__TAURI__) {
  const { listen } = window.__TAURI__.event;

  listen('config-updated', () => {
    previewTheme = null;
    previewCss = null;
    resetScrollLatch();
    reloadConfigAndSyncLibrary().catch(err => {
      console.error('[Main] Failed to refresh settings:', err);
    });
  });

  listen('config-changed', () => {
    resetScrollLatch();
    reloadConfigAndSyncLibrary().catch(err => {
      console.error('[Main] Failed to refresh settings:', err);
    });
  });

  listen('library-relocated', (event) => {
    reloadConfigAndSyncLibrary(event.payload).catch(err => {
      console.error('[Main] Failed to activate relocated Library:', err);
    });
  });

  listen('theme-preview', (e) => {
    previewTheme = e.payload;
    applyTheme(previewTheme);
  });
  
  listen('css-preview', (e) => {
    previewCss = e.payload;
    applyCustomCss(previewCss);
  });
}

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

  applyTheme(previewTheme !== null ? previewTheme : theme);
  applyCustomCss(previewCss !== null ? previewCss : customCss);
});

Core.init();
