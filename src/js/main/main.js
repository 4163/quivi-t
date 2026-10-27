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
  clearLibraryPathCaches,
  revealListTop
} from '../filepanel/filePanel.js';
import { bindKeyboardShortcuts, updateMenuShortcuts, resetScrollLatch, syncScrollLatch } from '../shortcuts.js';
import { applyTheme, applyCustomCss } from '../shared/theme.js';
import { DEFAULT_KEYBOARD_PAN_STEP, DEFAULT_WHEEL_PAN_STEP } from '../keybinds.js';
import { Statusbar } from '../menubar/statusbar.js';
import { initMenuBar, syncViewMenu } from '../menubar.js';
import * as Chrome from '../menubar/chrome.js';
import { initFullscreen, toggleFullscreen, syncFullscreenState, syncKeyLabel } from './fullscreen.js';

import { handleTabJump } from '../keyboardNav.js';
import { emergencyCssReset } from '../shared/configPreview.js';
import { ACTION_REGISTRY } from '../services/actions.js';

import { initLifecycle } from './lifecycle.js';
import { initMetadataBadge, openMetadataWindow } from './metadataBadge.js';
import { initDropZone } from './dropzone.js';
import { initPasswordOverlay } from './passwordOverlay.js';
import { initUrlOverlay } from './urlOverlay.js';
import { UrlLoader, sanitizeSvgDocument } from '../urlLoader.js';
import { createImportActions } from '../services/importActions.js';
import { activateImportProvider, MISC_PROVIDER } from '../filepanel/libraryStore.js';
import { initViewerAudio, ViewerAudio } from '../viewer/viewerAudio.js';
import { ManhwaAudio } from '../viewer/manhwaAudio.js';
import { initWorkspace } from './workspace.js';
import { workspaceSurface, ViewportCore } from '../shared/workspaceHost.js';
import { requestWorkspace } from '../shared/workspaceSession.js';
import { createWorkspaceControls } from '../shared/workspaceControls.js';
import {
  initManhwaStrip,
  isManhwaStripActive,
  alignListItemTop,
  alignListItemBottom,
  jumpManhwa,
  navigateManhwa,
  pageStrip,
  setRevealListTop,
  getVisibleImageIndices,
  isListIndexMapped,
  getAnchorImgIdx
} from '../viewer/manhwaStrip.js';

// Reset the options tab on startup so each session starts on General.
if (!workspaceSurface) localStorage.removeItem('options-active-tab');

// Emergency CSS reset (Ctrl+Shift+Alt+C).
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.altKey && e.key.toLowerCase() === 'c') {
    e.preventDefault();
    emergencyCssReset(Core.getState().config);
  }

  // Home/End jumps across tabbable controls.
  handleTabJump(e);
});

// Route strip jumps before the file list's row-based navigation.
window.addEventListener('keydown', (e) => {
  if (!isManhwaStripActive()) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.ctrlKey || e.altKey) return;

  let handled = false;
  if (e.key === 'Home') {
    handled = jumpManhwa(-1);
  } else if (e.key === 'End') {
    handled = jumpManhwa(1);
  } else if (e.key === 'PageUp') {
    handled = pageStrip(-1, 2);
  } else if (e.key === 'PageDown') {
    handled = pageStrip(1, 2);
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

let keyboardPanStep = DEFAULT_KEYBOARD_PAN_STEP;
let wheelPanStep = DEFAULT_WHEEL_PAN_STEP;

function setMenuItemMuted(id, muted) {
  const item = document.getElementById(id);
  if (!item) return;
  item.classList.toggle('muted', muted);
  item.setAttribute('aria-disabled', muted ? 'true' : 'false');
}

function updateHistoryMenu() {
  const history = workspaceSurface ? Core.getState().historyAvailable : null;
  setMenuItemMuted('cmd-history-back', !(history ? history.back : NavigationHistory.canGoBack()));
  setMenuItemMuted('cmd-history-forward', !(history ? history.forward : NavigationHistory.canGoForward()));
}

function updatePanSteps(config = Core.getState().config) {
  const fd = config?.frontend_data || {};
  keyboardPanStep = Number.isFinite(fd.keyboard_pan_step) ? fd.keyboard_pan_step : DEFAULT_KEYBOARD_PAN_STEP;
  wheelPanStep = Number.isFinite(fd.wheel_pan_step) ? fd.wheel_pan_step : DEFAULT_WHEEL_PAN_STEP;
}

function dispatchKeyboardPan(dx, dy) {
  if (dx === 0 && dy === 0) return;
  workspaceControls.panBy(dx * keyboardPanStep, dy * keyboardPanStep);
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
  get ManhwaAudio() { return ManhwaAudio; },
  getStripAnchorImgIdx: () => getAnchorImgIdx(),
  isFavoritesFocused: () => !!document.activeElement?.closest('#favorites-list'),
  isLibraryFocused: () => !!document.activeElement?.closest('#file-panel-library, .library-provider-list'),
  get keyboardPanStep() { return keyboardPanStep; },
  get wheelPanStep() { return wheelPanStep; },
  get alignListItemTop() { return alignListItemTop; },
  get alignListItemBottom() { return alignListItemBottom; },
  get navigateManhwa() { return navigateManhwa; },
  get pageStrip() { return pageStrip; }
};

const workspaceControls = createWorkspaceControls({ actionCtx, Viewer, getVisibleImageIndices,
  strip: { alignListItemTop, alignListItemBottom, navigateManhwa, pageStrip, jumpManhwa } });

function bindMenuCommands() {
  for (const action of ACTION_REGISTRY) {
    const el = document.getElementById(action.id);
    if (el) {
      el.addEventListener('click', (e) => {
        if (el.classList.contains('muted') || el.getAttribute('aria-disabled') === 'true') return;
        workspaceControls.dispatchAction(action.id, e);
      });
    }
  }

  syncViewMenu(Core.getState());
  updateHistoryMenu();
}

Core.onStateChange((state) => {
  updateMenuShortcuts(state.config);
  syncViewMenu(state);

  const isPasswordBlocked = state.archiveEncryption === 'password_required' || state.archiveEncryption === 'password_incorrect';

  if (state.mode === 'empty' && !isPasswordBlocked) {
    viewport.classList.add('empty');
    statusbar.classList.add('hidden');
    document.getElementById('img-grill')?.classList.remove('active');
    document.getElementById('img-grill-border')?.classList.remove('active');
    document.getElementById('manhwa-strip')?.classList.remove('grill-active');
    return;
  }

  // A selection with no strip row behaves like a folder: the overlay
  // covers the viewport. Mapped rows (images and videos alike) clear it.
  const stripUnmappedSelected = isManhwaStripActive() && state.index >= 0 && !isListIndexMapped(state.index);
  if (!state.src || stripUnmappedSelected) {
    viewport.classList.add('empty');
  } else {
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
    const wrapperEl = document.getElementById('viewer-img-wrapper');
    // Bootstrap fans out grill state. Viewer and strip paint their own surfaces from it.
    if (grillEl) grillEl.classList.toggle('active', showSingleGrill);
    if (grillBorderEl) grillBorderEl.classList.toggle('active', showSingleGrill);
    if (wrapperEl) wrapperEl.classList.toggle('grill-active', showSingleGrill);
    if (stripEl) stripEl.classList.toggle('grill-active', !isTransparent && isManhwaStripActive() && (state.list?.length || 0) > 0);
    if (toggleEl) {
      toggleEl.classList.toggle('checked', !isTransparent);
    }
  }

  // Update standard statusbar fields.
  Statusbar.update(state);

  updateHistoryMenu();
});

window.addEventListener('quivit-history-changed', () => {
  if (!workspaceSurface) Core.setState({ historyAvailable: { back: NavigationHistory.canGoBack(), forward: NavigationHistory.canGoForward() } });
  updateHistoryMenu();
});

// Initialization.
initWorkspace({ onDetachedClose: () => workspaceControls.dispatchAction('cmd-quit') });
Statusbar.init();
Chrome.initChrome();
initFullscreen();
initFilePanel({
  filePanel,
  breadcrumbEl: filePanelBreadcrumb,
  fileListUl,
  resizeHandle,
  Core,
  FsUtils,
  isManhwaActive: () => !!Core.getState().manhwaEnabled,
  getVisibleImageIndices: workspaceControls.visibleIndices,
  alignListItemTop: index => workspaceControls.stripCall('alignListItemTop', index),
  alignListItemBottom: index => workspaceControls.stripCall('alignListItemBottom', index),
  pageStrip: (...args) => workspaceControls.stripCall('pageStrip', ...args)
});
initManhwaStrip();
setRevealListTop(revealListTop);
initMenuBar();
bindMenuCommands();
initPasswordOverlay({ overlay: passwordOverlay, Core, FsUtils, focusFileList, isFileListFocused });
const importActions = workspaceControls.createImportActions(() => createImportActions({
  invoke: (command, args) => window.__TAURI__.core.invoke(command, args),
  FsUtils,
  loadUrl: (url) => UrlLoader.loadUrl(url),
  cancelUrlImport: (path) => UrlLoader.cancelGalleryDownloads(path),
  sanitizeSvg: sanitizeSvgDocument,
  activateMisc: () => activateImportProvider(MISC_PROVIDER),
  libraryUpdated: () => window.dispatchEvent(new CustomEvent('quivit-library-updated'))
}));
Chrome.initImportActivity(importActions);
const urlOverlay = initUrlOverlay({
  overlay: urlOverlayEl,
  filePanel,
  Core,
  focusFileList,
  onSubmit: (url) => importActions.openUrl(url)
});
initDropZone({
  dropOverlay, FsUtils, Core, importActions,
  isUnmappedSelection: (state) => isManhwaStripActive() && state.index >= 0 && !isListIndexMapped(state.index),
  onDropAccepted: () => urlOverlay.hide({ restoreFocus: false })
});
UrlLoader.init({ Core, FsUtils, urlOverlay, getFileListViewportRange,
  session: workspaceSurface ? (method, args) => requestWorkspace('main', 'url', method, args).catch(console.error) : null });
initMetadataBadge({ Core, FsUtils, badgeEl: metadataBadgeEl });
initViewerAudio({ Core: ViewportCore, FsUtils });
if (!workspaceSurface) initLifecycle({ Core, FsUtils, UrlLoader });

workspaceControls.connect({ importActions, UrlLoader });

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

bindKeyboardShortcuts({ Core, dispatchAction: workspaceControls.dispatchAction, dispatchKeyboardPan });

if (window.__TAURI__) {
  const { listen } = window.__TAURI__.event;

  listen('config-updated', () => {
    if (workspaceSurface) return;
    previewTheme = null;
    previewCss = null;
    resetScrollLatch();
    reloadConfigAndSyncLibrary().catch(err => {
      console.error('[Main] Failed to refresh settings:', err);
    });
  });

  listen('config-changed', () => {
    if (workspaceSurface) return;
    resetScrollLatch();
    reloadConfigAndSyncLibrary().catch(err => {
      console.error('[Main] Failed to refresh settings:', err);
    });
  });

  listen('library-relocated', (event) => {
    if (workspaceSurface) return;
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

if (workspaceSurface) {
  Core.receiveSnapshot({});
  window.dispatchEvent(new CustomEvent('quivit-config-loaded'));
  window.__TAURI__?.core.invoke('show_window').catch(console.error);
} else {
  Core.init();
}
