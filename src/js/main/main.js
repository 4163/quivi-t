/**
 * main/main.js - main window DOM wiring bootstrap.
 */

import { Core } from '../core.js';
import { FsUtils } from '../fsUtils.js';
import { Viewer } from '../viewer/viewer.js';
import * as NavigationHistory from '../navigationHistory.js';
import { initFilePanel, toggleFavoriteCurrent, getHighlightedFavorite, navigateHighlightedFavorite } from '../filepanel/filePanel.js';
import { bindKeyboardShortcuts, updateMenuShortcuts, resetScrollLatch, syncScrollLatch } from '../shortcuts.js';
import { applyTheme, applyCustomCss } from '../shared/theme.js';
import { DEFAULT_KEYBOARD_PAN_STEP, DEFAULT_WHEEL_PAN_STEP } from '../keybinds.js';
import { Statusbar } from '../menubar/statusbar.js';
import { initMenuBar } from '../menubar.js';
import * as Chrome from '../menubar/chrome.js';
import { initFullscreen, toggleFullscreen, syncFullscreenState, isFullscreenActive, syncKeyLabel } from './fullscreen.js';

import { handleTabJump } from '../keyboardNav.js';
import { emergencyCssReset } from '../shared/configPreview.js';
import { ACTION_REGISTRY, dispatch } from '../services/actions.js';

import { initLifecycle } from './lifecycle.js';
import { initMetadataBadge, openMetadataWindow } from './metadataBadge.js';
import { initDropZone } from './dropzone.js';

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
const viewport = document.getElementById('viewport');
const statusbar = document.getElementById('statusbar');
const filePanel = document.getElementById('file-panel');
const filePanelBreadcrumb = document.getElementById('file-panel-breadcrumb');
const fileListUl = document.getElementById('file-list');
const resizeHandle = document.getElementById('panel-resize-handle');
const metadataBadgeEl = document.getElementById('status-metadata-badge');

let activeScaling = '';
let _uiInitialized = false;
let keyboardPanStep = DEFAULT_KEYBOARD_PAN_STEP;
let wheelPanStep = DEFAULT_WHEEL_PAN_STEP;

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

Core.onStateChange((state) => {
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
});

window.addEventListener('quivit-history-changed', () => {
  updateHistoryMenu();
});

// Initialization sequence
Statusbar.init();
initFullscreen();
initFilePanel({ filePanel, breadcrumbEl: filePanelBreadcrumb, fileListUl, resizeHandle, Core, FsUtils });
initMenuBar();
bindMenuCommands();
initDropZone({ dropOverlay, FsUtils });
initMetadataBadge({ Core, FsUtils, badgeEl: metadataBadgeEl });
initLifecycle({ Core, FsUtils });

bindKeyboardShortcuts({ Core, dispatchAction: (id, payload) => dispatch(id, payload, actionCtx), dispatchKeyboardPan });

if (window.__TAURI__) {
  let previewTheme = null;
  let previewCss = null;

  const { listen } = window.__TAURI__.event;

  listen('config-updated', () => {
    previewTheme = null;
    previewCss = null;
    resetScrollLatch();
    Core.loadConfig();
  });

  listen('config-changed', () => {
    resetScrollLatch();
    Core.loadConfig();
  });

  listen('theme-preview', (e) => {
    previewTheme = e.payload;
    applyTheme(previewTheme);
  });
  
  listen('css-preview', (e) => {
    previewCss = e.payload;
    applyCustomCss(previewCss);
  });

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
} else {
  window.addEventListener('quivit-config-loaded', () => {
    const config = Core.getState().config;
    updatePanSteps(config);
    syncKeyLabel();
    syncScrollLatch(config);
    syncFullscreenState(!!document.fullscreenElement);

    const theme = config?.frontend_data?.theme || 'system';
    const customCss = config?.frontend_data?.custom_css || '';
    
    applyTheme(theme);
    applyCustomCss(customCss);
  });
}

Core.init();